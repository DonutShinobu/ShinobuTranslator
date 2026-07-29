import { describe, expect, it } from 'vitest';
import { IndexedDbLocalHistoryIndexAdapter } from '../../apps/web/src/features/history/browserHistoryAdapters';
import {
  HistoryCoordinationUnavailableError,
  WebHistoryBatchCoordinator,
} from '../../apps/web/src/features/history/historyCoordination';
import type {
  LocalHistoryBatch,
  LocalHistoryCleanupRecord,
} from '../../apps/web/src/features/history/localHistory';

type HeldLock = {
  name: string;
  mode: LockMode;
};

class ContractLockManager {
  private readonly held: HeldLock[] = [];

  request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';
    const conflicting = this.held.some(
      (lock) => lock.name === name && (lock.mode === 'exclusive' || mode === 'exclusive'),
    );
    if (conflicting && options.ifAvailable) return Promise.resolve(callback(null));
    if (conflicting) throw new Error(`Unexpected queued lock request: ${name}`);

    const held = { name, mode };
    this.held.push(held);
    const lock = { name, mode } as Lock;
    return Promise.resolve(callback(lock)).finally(() => {
      const index = this.held.indexOf(held);
      if (index >= 0) this.held.splice(index, 1);
    });
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: this.held.map(({ name, mode }) => ({ name, mode, clientId: 'contract' })),
      pending: [],
    };
  }
}

class ContractBroadcastHub {
  readonly channels = new Set<ContractBroadcastChannel>();

  open(name: string): BroadcastChannel {
    const channel = new ContractBroadcastChannel(name, this);
    this.channels.add(channel);
    return channel as unknown as BroadcastChannel;
  }
}

class ContractBroadcastChannel extends EventTarget {
  constructor(
    readonly name: string,
    private readonly hub: ContractBroadcastHub,
  ) {
    super();
  }

  postMessage(data: unknown): void {
    for (const channel of this.hub.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
  }

  close(): void {
    this.hub.channels.delete(this);
  }
}

function batch(): LocalHistoryBatch {
  return {
    schemaVersion: 3,
    id: 'batch-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    status: 'paused',
    rerunnable: true,
    lockedConfig: {
      schemaVersion: 1,
      targetLanguage: 'zh-CHS',
      processMode: 'translate',
      provider: {
        id: 'openai',
        target: 'https://api.openai.com/v1',
        model: 'gpt-test',
      },
    },
    versions: {
      app: '0.1.0',
      core: '0.8.1',
      model: 'model-v1',
      configSchema: 1,
    },
    recoveryPoint: {
      savedAt: '2026-07-29T00:00:00.000Z',
      nextItemIndex: 0,
    },
    items: [],
  };
}

describe('browser local-history adapter contracts', () => {
  it('uses a claim lock for occupancy while allowing shared read access', async () => {
    const locks = new ContractLockManager();
    const first = new WebHistoryBatchCoordinator(locks as unknown as LockManager, undefined);
    const second = new WebHistoryBatchCoordinator(locks as unknown as LockManager, undefined);

    const acquired = await first.acquire('batch-1');
    expect(acquired.status).toBe('acquired');
    await expect(second.acquire('batch-1')).resolves.toEqual({ status: 'occupied' });
    await expect(second.withRead('batch-1', async () => 'readable')).resolves.toBe('readable');
    await expect(second.occupiedBatchIds()).resolves.toEqual(new Set(['batch-1']));

    if (acquired.status === 'acquired') acquired.claim.release();
    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
    await expect(second.acquire('batch-1')).resolves.toMatchObject({ status: 'acquired' });
    first.dispose();
    second.dispose();
  });

  it('fails closed for claims and writes when Web Locks are unavailable', async () => {
    const coordinator = new WebHistoryBatchCoordinator(
      null as unknown as LockManager,
      undefined,
    );

    await expect(coordinator.acquire('batch-1')).resolves.toEqual({ status: 'unavailable' });
    await expect(coordinator.withRead('batch-1', async () => 'readable')).resolves.toBe('readable');
    await expect(coordinator.withWrite('batch-1', async () => undefined))
      .rejects.toBeInstanceOf(HistoryCoordinationUnavailableError);
  });

  it('uses BroadcastChannel only to invalidate another workbench snapshot', () => {
    const locks = new ContractLockManager();
    const broadcasts = new ContractBroadcastHub();
    const first = new WebHistoryBatchCoordinator(
      locks as unknown as LockManager,
      (name) => broadcasts.open(name),
    );
    const second = new WebHistoryBatchCoordinator(
      locks as unknown as LockManager,
      (name) => broadcasts.open(name),
    );
    let invalidations = 0;
    second.subscribe(() => {
      invalidations += 1;
    });

    first.publish('batch-1');

    expect(invalidations).toBe(1);
    first.dispose();
    second.dispose();
  });

  it('commits a batch and cleanup obligation through one IndexedDB transaction', async () => {
    const operations: Array<{ store: string; type: 'put' | 'delete'; value: unknown }> = [];
    const transactions: Array<{ stores: string[]; mode: IDBTransactionMode }> = [];
    const database = {
      transaction(storeNames: string | string[], mode: IDBTransactionMode) {
        const stores = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        transactions.push({ stores, mode });
        const transaction = new EventTarget() as IDBTransaction;
        Object.defineProperty(transaction, 'error', { value: null });
        Object.defineProperty(transaction, 'objectStore', {
          value: (store: string) => ({
            put: (value: unknown) => operations.push({ store, type: 'put', value }),
            delete: (value: unknown) => operations.push({ store, type: 'delete', value }),
          }),
        });
        queueMicrotask(() => transaction.dispatchEvent(new Event('complete')));
        return transaction;
      },
    } as IDBDatabase;
    const adapter = new IndexedDbLocalHistoryIndexAdapter(async () => database);
    const cleanup: LocalHistoryCleanupRecord = {
      id: 'cleanup-1',
      batchId: 'batch-1',
      operation: 'keep-results-only',
      createdAt: '2026-07-29T00:00:00.000Z',
      unreleasedBytes: 42,
      target: { type: 'assets', paths: ['batch-1/items/0/original'] },
    };

    await adapter.commit({ putBatch: batch(), putCleanup: cleanup });

    expect(transactions).toEqual([{
      stores: ['batches', 'cleanup-journal'],
      mode: 'readwrite',
    }]);
    expect(operations).toEqual([
      expect.objectContaining({ store: 'batches', type: 'put' }),
      expect.objectContaining({ store: 'cleanup-journal', type: 'put' }),
    ]);
  });
});
