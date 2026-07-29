export type HistoryBatchClaim = {
  release(): void;
};

export type HistoryBatchClaimResult =
  | {
      status: 'acquired';
      claim: HistoryBatchClaim;
    }
  | { status: 'occupied' }
  | { status: 'unavailable' };

export interface HistoryBatchCoordinator {
  acquire(batchId: string): Promise<HistoryBatchClaimResult>;
  occupiedBatchIds(): Promise<ReadonlySet<string>>;
  withRead<T>(batchId: string, operation: () => Promise<T>): Promise<T>;
  withWrite<T>(batchId: string, operation: () => Promise<T>): Promise<T>;
  subscribe(listener: () => void): () => void;
  publish(batchId: string): void;
  dispose(): void;
}

const WEB_LOCK_PREFIX = 'shinobu-local-history';

type HeldWebClaim = {
  references: number;
  releaseUnderlying(): void;
};

export class HistoryCoordinationUnavailableError extends Error {
  readonly code = 'coordination-unavailable';

  constructor() {
    super('This browser cannot coordinate local history writes across workbench instances');
    this.name = 'HistoryCoordinationUnavailableError';
  }
}

export class WebHistoryBatchCoordinator implements HistoryBatchCoordinator {
  private readonly listeners = new Set<() => void>();
  private readonly claims = new Map<string, HeldWebClaim>();
  private readonly channel?: BroadcastChannel;
  private disposed = false;

  constructor(
    private readonly locks: LockManager | undefined = globalThis.navigator?.locks,
    channelFactory: ((name: string) => BroadcastChannel) | undefined =
      typeof BroadcastChannel === 'undefined'
        ? undefined
        : (name) => new BroadcastChannel(name),
  ) {
    this.channel = channelFactory?.(`${WEB_LOCK_PREFIX}:updates`);
    this.channel?.addEventListener('message', this.handleMessage);
  }

  async acquire(batchId: string): Promise<HistoryBatchClaimResult> {
    if (this.disposed || !this.locks) return { status: 'unavailable' };
    const current = this.claims.get(batchId);
    if (current) {
      current.references += 1;
      return {
        status: 'acquired',
        claim: this.reference(batchId, current),
      };
    }

    return new Promise<HistoryBatchClaimResult>((resolve) => {
      let settled = false;
      void this.locks!.request(
        this.claimName(batchId),
        {
          mode: 'exclusive',
          ifAvailable: true,
        },
        async (lock) => {
          if (!lock || this.disposed) {
            settled = true;
            resolve(this.disposed ? { status: 'unavailable' } : { status: 'occupied' });
            return;
          }
          let releaseUnderlying = (): void => undefined;
          const released = new Promise<void>((release) => {
            releaseUnderlying = release;
          });
          const held: HeldWebClaim = {
            references: 1,
            releaseUnderlying,
          };
          this.claims.set(batchId, held);
          settled = true;
          resolve({
            status: 'acquired',
            claim: this.reference(batchId, held),
          });
          this.publish(batchId);
          await released;
        },
      ).catch(() => {
        if (!settled) resolve({ status: 'unavailable' });
      });
    });
  }

  async occupiedBatchIds(): Promise<ReadonlySet<string>> {
    const occupied = new Set(this.claims.keys());
    if (!this.locks) return occupied;
    try {
      const snapshot = await this.locks.query();
      for (const lock of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
        const batchId = this.batchIdFromClaimName(lock.name);
        if (batchId) occupied.add(batchId);
      }
    } catch {
      // Requests still fail closed even when lock inspection is unavailable.
    }
    return occupied;
  }

  async withRead<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.locks) return operation();
    return this.locks.request(
      this.accessName(batchId),
      { mode: 'shared' },
      operation,
    );
  }

  async withWrite<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.locks) throw new HistoryCoordinationUnavailableError();
    return this.locks.request(
      this.accessName(batchId),
      { mode: 'exclusive' },
      operation,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(batchId: string): void {
    this.channel?.postMessage({ batchId });
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const claim of this.claims.values()) claim.releaseUnderlying();
    this.claims.clear();
    this.channel?.removeEventListener('message', this.handleMessage);
    this.channel?.close();
    this.listeners.clear();
  }

  private readonly handleMessage = (): void => {
    this.emit();
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private reference(batchId: string, held: HeldWebClaim): HistoryBatchClaim {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        held.references -= 1;
        if (held.references > 0) return;
        if (this.claims.get(batchId) === held) this.claims.delete(batchId);
        held.releaseUnderlying();
        this.publish(batchId);
      },
    };
  }

  private claimName(batchId: string): string {
    return `${WEB_LOCK_PREFIX}:claim:${encodeURIComponent(batchId)}`;
  }

  private accessName(batchId: string): string {
    return `${WEB_LOCK_PREFIX}:access:${encodeURIComponent(batchId)}`;
  }

  private batchIdFromClaimName(name: string | null | undefined): string | undefined {
    const prefix = `${WEB_LOCK_PREFIX}:claim:`;
    if (!name?.startsWith(prefix)) return undefined;
    try {
      return decodeURIComponent(name.slice(prefix.length));
    } catch {
      return undefined;
    }
  }
}

type MemoryClaim = {
  ownerId: string;
  references: number;
};

export class MemoryHistoryCoordinationHub {
  readonly claims = new Map<string, MemoryClaim>();
  readonly listeners = new Set<() => void>();

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class MemoryHistoryBatchCoordinator implements HistoryBatchCoordinator {
  private disposed = false;

  constructor(
    private readonly hub = new MemoryHistoryCoordinationHub(),
    private readonly ownerId: string = crypto.randomUUID(),
  ) {}

  async acquire(batchId: string): Promise<HistoryBatchClaimResult> {
    if (this.disposed) return { status: 'unavailable' };
    const current = this.hub.claims.get(batchId);
    if (current && current.ownerId !== this.ownerId) return { status: 'occupied' };
    if (current) current.references += 1;
    else this.hub.claims.set(batchId, { ownerId: this.ownerId, references: 1 });
    this.hub.emit();
    let released = false;
    return {
      status: 'acquired',
      claim: {
        release: () => {
          if (released) return;
          released = true;
          const claim = this.hub.claims.get(batchId);
          if (!claim || claim.ownerId !== this.ownerId) return;
          claim.references -= 1;
          if (claim.references === 0) this.hub.claims.delete(batchId);
          this.hub.emit();
        },
      },
    };
  }

  async occupiedBatchIds(): Promise<ReadonlySet<string>> {
    return new Set(this.hub.claims.keys());
  }

  async withRead<T>(_batchId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async withWrite<T>(_batchId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  subscribe(listener: () => void): () => void {
    this.hub.listeners.add(listener);
    return () => this.hub.listeners.delete(listener);
  }

  publish(_batchId: string): void {
    this.hub.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [batchId, claim] of this.hub.claims) {
      if (claim.ownerId === this.ownerId) this.hub.claims.delete(batchId);
    }
    this.hub.emit();
  }
}
