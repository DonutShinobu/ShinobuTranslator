import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import {
  LocalHistory,
  MemoryLocalHistoryAssetAdapter,
  MemoryLocalHistoryIndexAdapter,
} from '../../apps/web/src/features/history/localHistory';
import {
  MemoryHistoryBatchCoordinator,
  MemoryHistoryCoordinationHub,
} from '../../apps/web/src/features/history/historyCoordination';
import {
  createLocalHistoryLifecycle,
  type HistoryScheduler,
  type LocalHistoryWorkbenchAdapter,
} from '../../apps/web/src/features/history/localHistoryLifecycle';

function file(name: string, contents: string): File {
  return new File([contents], name, { type: 'image/png' });
}

function workbench(): LocalHistoryWorkbenchAdapter {
  return {
    occupied: () => false,
    installRecovery: async () => undefined,
    installDraft: async () => undefined,
    discardRecovery: () => undefined,
  };
}

function recordingWorkbench() {
  const recoveries: Array<Parameters<LocalHistoryWorkbenchAdapter['installRecovery']>[0]> = [];
  const drafts: Array<Parameters<LocalHistoryWorkbenchAdapter['installDraft']>[0]> = [];
  const adapter: LocalHistoryWorkbenchAdapter = {
    occupied: () => recoveries.length > 0 || drafts.length > 0,
    installRecovery: async (preparation) => {
      recoveries.push(preparation);
    },
    installDraft: async (preparation) => {
      drafts.push(preparation);
    },
    discardRecovery: () => {
      recoveries.length = 0;
    },
  };
  return { adapter, recoveries, drafts };
}

function manualScheduler() {
  let task: (() => Promise<void> | void) | undefined;
  const scheduler: HistoryScheduler = {
    schedule(_delayMs, next) {
      task = next;
      return () => {
        task = undefined;
      };
    },
  };
  return {
    scheduler,
    async run() {
      const current = task;
      task = undefined;
      await current?.();
    },
  };
}

async function setup() {
  const index = new MemoryLocalHistoryIndexAdapter();
  const generatedIds = ['batch-1', 'batch-2'];
  const history = new LocalHistory(
    index,
    new MemoryLocalHistoryAssetAdapter(),
    { now: () => new Date('2026-07-29T00:00:00.000Z') },
    { create: () => generatedIds.shift() ?? 'batch-fallback' },
  );
  await history.createBatch({
    settings: createDefaultWebSettings('zh-CN'),
    versions: {
      app: '0.1.0',
      core: '0.8.1',
      model: 'model-v1',
      configSchema: 1,
    },
    items: [{
      id: 'image-1',
      file: file('page.png', 'original'),
      width: 1200,
      height: 1800,
      workingCopy: {
        required: false,
        width: 1200,
        height: 1800,
        scale: 1,
      },
    }],
  });
  const hub = new MemoryHistoryCoordinationHub();
  const coordinator = new MemoryHistoryBatchCoordinator(hub, 'tab-a');
  const lifecycle = createLocalHistoryLifecycle({
    history,
    coordinator,
    workbench: workbench(),
  });
  return { lifecycle, history, index, hub };
}

describe('local history lifecycle module', () => {
  it('projects operation eligibility into its snapshot', async () => {
    const { lifecycle } = await setup();

    await expect(lifecycle.request({ type: 'refresh' })).resolves.toEqual({
      status: 'succeeded',
      type: 'refreshed',
    });

    expect(lifecycle.snapshot()).toMatchObject({
      status: 'ready',
      busy: false,
      entries: [{
        batch: { id: 'batch-1' },
        integrity: 'complete',
        completedCount: 0,
        eligibility: {
          resume: { allowed: true },
          clone: { allowed: true },
          exportResults: { allowed: false, code: 'no-results' },
          exportProject: { allowed: true },
          keepResultsOnly: { allowed: false, code: 'no-results' },
          delete: { allowed: true },
        },
      }],
    });
  });

  it('holds a per-batch recovery claim across workbench instances', async () => {
    const { history, hub } = await setup();
    const firstWorkbench = recordingWorkbench();
    const first = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'tab-first'),
      workbench: firstWorkbench.adapter,
    });
    const second = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'tab-second'),
      workbench: workbench(),
    });
    await first.request({ type: 'refresh' });
    await second.request({ type: 'refresh' });

    await expect(first.request({
      type: 'prepare-resume',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'recovery-prepared',
      batchId: 'batch-1',
    });
    expect(firstWorkbench.recoveries[0]).toMatchObject({
      kind: 'recovery',
      batch: { id: 'batch-1' },
      files: [{ name: 'page.png' }],
    });

    await second.request({ type: 'refresh' });
    expect(second.snapshot().entries[0].eligibility.resume).toEqual({
      allowed: false,
      code: 'batch-occupied',
    });
    await expect(second.request({
      type: 'prepare-resume',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'rejected',
      code: 'batch-occupied',
      batchId: 'batch-1',
    });

    first.dispose();
    await second.request({ type: 'refresh' });
    expect(second.snapshot().entries[0].eligibility.resume).toEqual({ allowed: true });
  });

  it('clones an unavailable provider into a draft that requires a new selection', async () => {
    const { history, index, hub } = await setup();
    const stored = (await history.get('batch-1'))!;
    stored.lockedConfig.provider.id = 'removed-provider';
    await index.put(stored);
    const targetWorkbench = recordingWorkbench();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'clone-tab'),
      workbench: targetWorkbench.adapter,
    });
    await lifecycle.request({ type: 'refresh' });

    expect(lifecycle.snapshot().entries[0].eligibility.resume).toEqual({
      allowed: false,
      code: 'provider-unavailable',
    });
    expect(lifecycle.snapshot().entries[0].eligibility.clone).toEqual({ allowed: true });
    await expect(lifecycle.request({
      type: 'prepare-clone',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'draft-prepared',
      batchId: 'batch-1',
      providerSelectionRequired: true,
    });
    expect(targetWorkbench.drafts[0]).toMatchObject({
      kind: 'draft',
      sourceBatch: { id: 'batch-1' },
      providerSelectionRequired: true,
      files: [{ name: 'page.png' }],
    });
  });

  it('owns the delayed delete window and releases its claim on undo', async () => {
    const { history, hub } = await setup();
    const timer = manualScheduler();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'delete-tab'),
      workbench: workbench(),
      scheduler: timer.scheduler,
      clock: { now: () => new Date('2026-07-29T00:00:00.000Z') },
    });
    const observer = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'observer-tab'),
      workbench: workbench(),
    });
    await lifecycle.request({ type: 'refresh' });
    await observer.request({ type: 'refresh' });

    await expect(lifecycle.request({
      type: 'stage-delete',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'pending-staged',
      operation: 'delete',
      batchId: 'batch-1',
    });
    expect(lifecycle.snapshot().pending).toEqual({
      type: 'delete',
      batchId: 'batch-1',
      expiresAt: '2026-07-29T00:00:10.000Z',
    });
    await observer.request({ type: 'refresh' });
    expect(observer.snapshot().entries[0].eligibility.delete).toEqual({
      allowed: false,
      code: 'batch-occupied',
    });

    await lifecycle.request({ type: 'undo-pending' });
    expect(await history.get('batch-1')).not.toBeNull();
    expect(lifecycle.snapshot().pending).toBeUndefined();

    await lifecycle.request({ type: 'stage-delete', batchId: 'batch-1' });
    await timer.run();
    expect(await history.get('batch-1')).toBeNull();
    expect(lifecycle.snapshot().entries).toEqual([]);
  });

  it('keeps a delayed logical-commit failure visible after refreshing the snapshot', async () => {
    class FailingDeleteIndex extends MemoryLocalHistoryIndexAdapter {
      override async commit(
        input: Parameters<MemoryLocalHistoryIndexAdapter['commit']>[0],
      ): Promise<void> {
        if (input.deleteBatchId) throw new Error('index commit unavailable');
        await super.commit(input);
      }
    }
    const index = new FailingDeleteIndex();
    const history = new LocalHistory(
      index,
      new MemoryLocalHistoryAssetAdapter(),
      { now: () => new Date('2026-07-29T00:00:00.000Z') },
      { create: () => 'batch-1' },
    );
    await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
      items: [{
        id: 'image-1',
        file: file('page.png', 'original'),
        width: 1200,
        height: 1800,
        workingCopy: {
          required: false,
          width: 1200,
          height: 1800,
          scale: 1,
        },
      }],
    });
    const timer = manualScheduler();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(
        new MemoryHistoryCoordinationHub(),
        'failing-delete-tab',
      ),
      workbench: workbench(),
      scheduler: timer.scheduler,
    });
    await lifecycle.request({ type: 'refresh' });
    await lifecycle.request({ type: 'stage-delete', batchId: 'batch-1' });

    await timer.run();

    expect(await history.get('batch-1')).not.toBeNull();
    expect(lifecycle.snapshot().failure).toEqual({
      operation: 'delete',
      cause: 'index commit unavailable',
    });
  });

  it('cancels a page-local pending operation when the lifecycle is disposed', async () => {
    const { history, hub } = await setup();
    const timer = manualScheduler();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'closing-tab'),
      workbench: workbench(),
      scheduler: timer.scheduler,
    });
    await lifecycle.request({ type: 'refresh' });
    await lifecycle.request({ type: 'stage-delete', batchId: 'batch-1' });

    lifecycle.dispose();
    await timer.run();

    expect(await history.get('batch-1')).not.toBeNull();
  });

  it('delays results-only cleanup until the undo window expires', async () => {
    const { history, hub } = await setup();
    await history.updateItem('batch-1', 'image-1', {
      status: 'done',
      result: new Blob(['result'], { type: 'image/png' }),
    });
    await history.finishBatch('batch-1', 'completed');
    const timer = manualScheduler();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'compact-tab'),
      workbench: workbench(),
      scheduler: timer.scheduler,
      clock: { now: () => new Date('2026-07-29T00:00:00.000Z') },
    });
    await lifecycle.request({ type: 'refresh' });

    await expect(lifecycle.request({
      type: 'stage-keep-results-only',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'pending-staged',
      operation: 'keep-results-only',
      batchId: 'batch-1',
    });
    expect((await history.get('batch-1'))?.rerunnable).toBe(true);

    await timer.run();

    const compacted = await history.get('batch-1');
    expect(compacted).toMatchObject({
      rerunnable: false,
      items: [{ original: undefined, result: { size: 6 } }],
    });
    expect(lifecycle.snapshot().entries[0].eligibility.clone).toEqual({
      allowed: false,
      code: 'results-only',
    });
  });

  it('returns host-saveable archives and imports projects under a new batch identity', async () => {
    const { lifecycle, history } = await setup();
    await history.updateItem('batch-1', 'image-1', {
      status: 'done',
      result: new Blob(['translated'], { type: 'image/png' }),
    });
    await history.finishBatch('batch-1', 'completed');
    await lifecycle.request({ type: 'refresh' });

    const exported = await lifecycle.request({
      type: 'export-project',
      batchId: 'batch-1',
    });
    expect(exported).toMatchObject({
      status: 'succeeded',
      type: 'artifact-ready',
      artifact: {
        kind: 'project',
        fileName: '2026-07-29-batch-1.shinobu.zip',
        blob: { type: 'application/zip' },
      },
    });
    if (exported.status !== 'succeeded' || exported.type !== 'artifact-ready') {
      throw new Error('Expected a project artifact');
    }

    await expect(lifecycle.request({
      type: 'import-project',
      file: new File([exported.artifact.blob], exported.artifact.fileName, {
        type: 'application/zip',
      }),
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'project-imported',
      batchId: 'batch-2',
    });
    expect((await history.list()).map((batch) => batch.id).sort()).toEqual([
      'batch-1',
      'batch-2',
    ]);
  });

  it('returns result downloads and ZIP metadata without performing host side effects', async () => {
    const { lifecycle, history } = await setup();
    await history.updateItem('batch-1', 'image-1', {
      status: 'done',
      result: new Blob(['translated'], { type: 'image/png' }),
    });
    await history.finishBatch('batch-1', 'completed');
    await lifecycle.request({ type: 'refresh' });

    const single = await lifecycle.request({
      type: 'download-result',
      batchId: 'batch-1',
      itemId: 'image-1',
    });
    expect(single).toMatchObject({
      status: 'succeeded',
      type: 'artifact-ready',
      artifact: {
        kind: 'result',
        fileName: 'page.png',
        blob: { size: 10, type: 'image/png' },
      },
    });

    const archive = await lifecycle.request({
      type: 'export-results',
      batchId: 'batch-1',
    });
    expect(archive).toMatchObject({
      status: 'succeeded',
      type: 'artifact-ready',
      artifact: {
        kind: 'results',
        fileName: '2026-07-29-shinobu-results.zip',
        exportedCount: 1,
        omissions: [],
        blob: { type: 'application/zip' },
      },
    });
  });

  it('discards an unused recovery preparation without mutating its history', async () => {
    const { history, hub } = await setup();
    const targetWorkbench = recordingWorkbench();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator: new MemoryHistoryBatchCoordinator(hub, 'recovery-tab'),
      workbench: targetWorkbench.adapter,
    });
    await lifecycle.request({ type: 'refresh' });
    await lifecycle.request({ type: 'prepare-resume', batchId: 'batch-1' });

    await expect(lifecycle.request({
      type: 'discard-recovery',
      batchId: 'batch-1',
    })).resolves.toEqual({
      status: 'succeeded',
      type: 'recovery-discarded',
      batchId: 'batch-1',
    });

    expect(targetWorkbench.recoveries).toEqual([]);
    expect((await history.get('batch-1'))?.status).toBe('running');
    expect((await lifecycle.request({ type: 'refresh' })).status).toBe('succeeded');
    expect(lifecycle.snapshot().entries[0].eligibility.resume).toEqual({ allowed: true });
  });
});
