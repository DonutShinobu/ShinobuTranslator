import { isKnownTranslationProviderId } from '@shinobu/shared-config';
import type {
  LocalHistory,
  LocalHistoryBatch,
  LocalHistoryCleanupFault,
  LocalHistoryInspection,
} from './localHistory';
import type {
  HistoryBatchClaim,
  HistoryBatchCoordinator,
} from './historyCoordination';
import {
  buildProjectPackage,
  buildResultsZip,
  validateProjectPackage,
  type ResultsZipOmission,
} from './projectPackage';

export type HistoryRejectionCode =
  | 'workbench-occupied'
  | 'batch-occupied'
  | 'partial-history'
  | 'results-only'
  | 'no-results'
  | 'nothing-to-resume'
  | 'provider-unavailable'
  | 'result-unavailable'
  | 'recovery-not-prepared'
  | 'pending-operation'
  | 'coordination-unavailable'
  | 'batch-not-found';

export type HistoryAvailability =
  | { allowed: true }
  | {
      allowed: false;
      code: HistoryRejectionCode;
    };

export type LocalHistoryEntryProjection = LocalHistoryInspection & {
  completedCount: number;
  eligibility: {
    resume: HistoryAvailability;
    clone: HistoryAvailability;
    exportResults: HistoryAvailability;
    exportProject: HistoryAvailability;
    keepResultsOnly: HistoryAvailability;
    delete: HistoryAvailability;
  };
};

export type LocalHistorySnapshot = {
  status: 'loading' | 'ready';
  entries: readonly LocalHistoryEntryProjection[];
  busy: boolean;
  faults: readonly LocalHistoryCleanupFault[];
  pending?: {
    type: 'delete' | 'keep-results-only';
    batchId: string;
    expiresAt: string;
  };
  failure?: {
    operation: string;
    cause: string;
  };
};

export type HistoryRecoveryPreparation = {
  kind: 'recovery';
  batch: LocalHistoryBatch;
  files: readonly File[];
};

export type HistoryDraftPreparation = {
  kind: 'draft';
  sourceBatch: LocalHistoryBatch;
  files: readonly File[];
  providerSelectionRequired: boolean;
};

export interface LocalHistoryWorkbenchAdapter {
  occupied(): boolean;
  installRecovery(preparation: HistoryRecoveryPreparation): Promise<void>;
  installDraft(preparation: HistoryDraftPreparation): Promise<void>;
  discardRecovery(batchId: string): void;
}

export interface HistoryScheduler {
  schedule(delayMs: number, task: () => Promise<void> | void): () => void;
}

export type HistoryLifecycleClock = {
  now(): Date;
};

export type HistoryIntent =
  | { type: 'refresh' }
  | {
      type: 'prepare-resume';
      batchId: string;
    }
  | {
      type: 'prepare-clone';
      batchId: string;
    }
  | {
      type: 'stage-delete';
      batchId: string;
    }
  | {
      type: 'stage-keep-results-only';
      batchId: string;
    }
  | {
      type: 'export-project';
      batchId: string;
    }
  | {
      type: 'import-project';
      file: File;
    }
  | {
      type: 'download-result';
      batchId: string;
      itemId: string;
    }
  | {
      type: 'export-results';
      batchId: string;
    }
  | {
      type: 'discard-recovery' | 'handoff-recovery';
      batchId: string;
    }
  | { type: 'retry-cleanup' }
  | { type: 'undo-pending' };

export type HistoryArtifact =
  | {
      kind: 'project';
      blob: Blob;
      fileName: string;
    }
  | {
      kind: 'result';
      blob: Blob;
      fileName: string;
    }
  | {
      kind: 'results';
      blob: Blob;
      fileName: string;
      exportedCount: number;
      omissions: ResultsZipOmission[];
    };

export type HistoryOutcome =
  | {
      status: 'succeeded';
      type: 'refreshed';
    }
  | {
      status: 'succeeded';
      type: 'recovery-prepared';
      batchId: string;
    }
  | {
      status: 'succeeded';
      type: 'draft-prepared';
      batchId: string;
      providerSelectionRequired: boolean;
    }
  | {
      status: 'succeeded';
      type: 'pending-staged';
      operation: 'delete' | 'keep-results-only';
      batchId: string;
    }
  | {
      status: 'succeeded';
      type: 'pending-undone';
      batchId: string;
    }
  | {
      status: 'succeeded';
      type: 'artifact-ready';
      artifact: HistoryArtifact;
    }
  | {
      status: 'succeeded';
      type: 'project-imported';
      batchId: string;
    }
  | {
      status: 'succeeded';
      type: 'recovery-discarded' | 'recovery-handed-off';
      batchId: string;
    }
  | {
      status: 'succeeded';
      type: 'cleanup-retried';
    }
  | {
      status: 'rejected';
      code: HistoryRejectionCode;
      batchId?: string;
    }
  | {
      status: 'failed';
      operation: string;
      cause: string;
    };

export interface LocalHistoryLifecycle {
  snapshot(): LocalHistorySnapshot;
  subscribe(listener: () => void): () => void;
  request(intent: HistoryIntent): Promise<HistoryOutcome>;
  dispose(): void;
}

export type LocalHistoryLifecycleDependencies = {
  history: LocalHistory;
  coordinator: HistoryBatchCoordinator;
  workbench: LocalHistoryWorkbenchAdapter;
  scheduler?: HistoryScheduler;
  clock?: HistoryLifecycleClock;
};

const defaultScheduler: HistoryScheduler = {
  schedule(delayMs, task) {
    const timer = globalThis.setTimeout(() => {
      void task();
    }, delayMs);
    return () => globalThis.clearTimeout(timer);
  },
};

const defaultClock: HistoryLifecycleClock = {
  now: () => new Date(),
};

type PendingHistoryOperation = {
  type: 'delete' | 'keep-results-only';
  batchId: string;
  claim: HistoryBatchClaim;
  cancel: () => void;
};

function availability(
  allowed: boolean,
  code: HistoryRejectionCode,
): HistoryAvailability {
  return allowed ? { allowed: true } : { allowed: false, code };
}

function projectEntry(
  inspection: LocalHistoryInspection,
  workbenchOccupied: boolean,
  occupiedBatchIds: ReadonlySet<string>,
): LocalHistoryEntryProjection {
  const { batch, integrity } = inspection;
  const completedCount = batch.items.filter((item) => item.status === 'done').length;
  const batchOccupied = occupiedBatchIds.has(batch.id);
  const resumableTasks = batch.items.some(
    (item) => item.status === 'queued' || item.status === 'running',
  );
  const providerAvailable = isKnownTranslationProviderId(batch.lockedConfig.provider.id);
  const resumeCode: HistoryRejectionCode = workbenchOccupied
    ? 'workbench-occupied'
    : batchOccupied
      ? 'batch-occupied'
      : integrity === 'partial'
        ? 'partial-history'
        : !batch.rerunnable
          ? 'results-only'
          : !providerAvailable
            ? 'provider-unavailable'
            : 'nothing-to-resume';
  const cloneCode: HistoryRejectionCode = workbenchOccupied
    ? 'workbench-occupied'
    : batchOccupied
      ? 'batch-occupied'
      : integrity === 'partial'
        ? 'partial-history'
        : 'results-only';
  return {
    ...inspection,
    completedCount,
    eligibility: {
      resume: availability(
        !workbenchOccupied
        && !batchOccupied
        && integrity === 'complete'
        && batch.rerunnable
        && providerAvailable
        && resumableTasks,
        resumeCode,
      ),
      clone: availability(
        !workbenchOccupied
        && !batchOccupied
        && integrity === 'complete'
        && batch.rerunnable,
        cloneCode,
      ),
      exportResults: availability(completedCount > 0, 'no-results'),
      exportProject: availability(integrity === 'complete', 'partial-history'),
      keepResultsOnly: availability(
        !batchOccupied && batch.rerunnable && completedCount > 0,
        batchOccupied
          ? 'batch-occupied'
          : !batch.rerunnable
            ? 'results-only'
            : 'no-results',
      ),
      delete: availability(!batchOccupied, 'batch-occupied'),
    },
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class LocalHistoryLifecycleImplementation implements LocalHistoryLifecycle {
  private readonly listeners = new Set<() => void>();
  private state: LocalHistorySnapshot = {
    status: 'loading',
    entries: [],
    busy: false,
    faults: [],
  };
  private disposed = false;
  private recoveryClaim?: {
    batchId: string;
    claim: HistoryBatchClaim;
  };
  private pendingOperation?: PendingHistoryOperation;
  private readonly unsubscribeCoordinator: () => void;
  private readonly scheduler: HistoryScheduler;
  private readonly clock: HistoryLifecycleClock;
  private operationTail = Promise.resolve();

  constructor(private readonly dependencies: LocalHistoryLifecycleDependencies) {
    this.scheduler = dependencies.scheduler ?? defaultScheduler;
    this.clock = dependencies.clock ?? defaultClock;
    this.unsubscribeCoordinator = dependencies.coordinator.subscribe(() => {
      if (!this.disposed) void this.enqueue(() => this.refresh());
    });
  }

  snapshot(): LocalHistorySnapshot {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(intent: HistoryIntent): Promise<HistoryOutcome> {
    return this.enqueue(() => this.dispatch(intent));
  }

  private async dispatch(intent: HistoryIntent): Promise<HistoryOutcome> {
    if (intent.type === 'refresh') return this.refresh();
    this.state = {
      ...this.state,
      busy: true,
      failure: undefined,
    };
    this.emit();
    try {
      if (intent.type === 'prepare-resume') return await this.prepareResume(intent.batchId);
      if (intent.type === 'prepare-clone') return await this.prepareClone(intent.batchId);
      if (intent.type === 'stage-delete') return await this.stageDelete(intent.batchId);
      if (intent.type === 'stage-keep-results-only') {
        return await this.stageKeepResultsOnly(intent.batchId);
      }
      if (intent.type === 'export-project') return await this.exportProject(intent.batchId);
      if (intent.type === 'import-project') return await this.importProject(intent.file);
      if (intent.type === 'download-result') {
        return await this.downloadResult(intent.batchId, intent.itemId);
      }
      if (intent.type === 'export-results') return await this.exportResults(intent.batchId);
      if (intent.type === 'discard-recovery') {
        return await this.releaseRecovery(intent.batchId, true);
      }
      if (intent.type === 'handoff-recovery') {
        return await this.releaseRecovery(intent.batchId, false);
      }
      if (intent.type === 'retry-cleanup') return await this.retryCleanup();
      if (intent.type === 'undo-pending') return await this.undoPending();
      return {
        status: 'failed',
        operation: 'unknown',
        cause: 'Unknown local history intent',
      };
    } finally {
      this.state = {
        ...this.state,
        busy: false,
      };
      this.emit();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recoveryClaim?.claim.release();
    this.recoveryClaim = undefined;
    this.pendingOperation?.cancel();
    this.pendingOperation?.claim.release();
    this.pendingOperation = undefined;
    this.unsubscribeCoordinator();
    this.dependencies.coordinator.dispose();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async refresh(): Promise<HistoryOutcome> {
    if (this.disposed) {
      return {
        status: 'failed',
        operation: 'refresh',
        cause: 'Local history lifecycle is disposed',
      };
    }
    this.state = {
      ...this.state,
      busy: true,
      failure: undefined,
    };
    this.emit();
    try {
      const batches = await this.dependencies.history.list();
      const [inspections, faults, occupiedBatchIds] = await Promise.all([
        Promise.all(batches.map((batch) => this.dependencies.history.inspect(batch.id))),
        this.dependencies.history.listCleanupFaults(),
        this.dependencies.coordinator.occupiedBatchIds(),
      ]);
      this.state = {
        ...this.state,
        status: 'ready',
        busy: false,
        entries: inspections
          .filter((entry): entry is LocalHistoryInspection => entry !== null)
          .map((entry) => projectEntry(
            entry,
            this.dependencies.workbench.occupied(),
            occupiedBatchIds,
          )),
        faults,
        failure: undefined,
      };
      this.emit();
      return { status: 'succeeded', type: 'refreshed' };
    } catch (error) {
      const cause = messageFor(error);
      this.state = {
        ...this.state,
        status: 'ready',
        busy: false,
        failure: {
          operation: 'refresh',
          cause,
        },
      };
      this.emit();
      return {
        status: 'failed',
        operation: 'refresh',
        cause,
      };
    }
  }

  private async prepareResume(batchId: string): Promise<HistoryOutcome> {
    if (this.dependencies.workbench.occupied()) {
      return {
        status: 'rejected',
        code: 'workbench-occupied',
        batchId,
      };
    }
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.resume.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.resume.code,
        batchId,
      };
    }
    const acquired = await this.dependencies.coordinator.acquire(batchId);
    if (acquired.status !== 'acquired') {
      return {
        status: 'rejected',
        code: acquired.status === 'occupied'
          ? 'batch-occupied'
          : 'coordination-unavailable',
        batchId,
      };
    }
    try {
      const inspection = await this.dependencies.coordinator.withRead(
        batchId,
        () => this.dependencies.history.inspect(batchId),
      );
      if (!inspection) {
        acquired.claim.release();
        return {
          status: 'rejected',
          code: 'batch-not-found',
          batchId,
        };
      }
      if (inspection.integrity !== 'complete') {
        acquired.claim.release();
        return {
          status: 'rejected',
          code: 'partial-history',
          batchId,
        };
      }
      if (!inspection.batch.rerunnable) {
        acquired.claim.release();
        return {
          status: 'rejected',
          code: 'results-only',
          batchId,
        };
      }
      if (!isKnownTranslationProviderId(inspection.batch.lockedConfig.provider.id)) {
        acquired.claim.release();
        return {
          status: 'rejected',
          code: 'provider-unavailable',
          batchId,
        };
      }
      if (!inspection.batch.items.some(
        (item) => item.status === 'queued' || item.status === 'running',
      )) {
        acquired.claim.release();
        return {
          status: 'rejected',
          code: 'nothing-to-resume',
          batchId,
        };
      }
      const files: File[] = [];
      for (const item of [...inspection.batch.items]
        .sort((left, right) => left.order - right.order)) {
        if (!item.original) throw new Error(`Missing original asset for ${item.id}`);
        const blob = await this.dependencies.history.readAsset(item.original);
        if (!blob) throw new Error(`Missing or corrupt original asset: ${item.original.fileName}`);
        files.push(new File([blob], item.original.fileName, {
          type: item.original.mediaType,
          lastModified: new Date(inspection.batch.createdAt).getTime(),
        }));
      }
      await this.dependencies.workbench.installRecovery({
        kind: 'recovery',
        batch: inspection.batch,
        files,
      });
      this.recoveryClaim?.claim.release();
      this.recoveryClaim = {
        batchId,
        claim: acquired.claim,
      };
      await this.refresh();
      return {
        status: 'succeeded',
        type: 'recovery-prepared',
        batchId,
      };
    } catch (error) {
      acquired.claim.release();
      const cause = messageFor(error);
      this.state = {
        ...this.state,
        failure: {
          operation: 'prepare-resume',
          cause,
        },
      };
      this.emit();
      return {
        status: 'failed',
        operation: 'prepare-resume',
        cause,
      };
    }
  }

  private async prepareClone(batchId: string): Promise<HistoryOutcome> {
    if (this.dependencies.workbench.occupied()) {
      return {
        status: 'rejected',
        code: 'workbench-occupied',
        batchId,
      };
    }
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.clone.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.clone.code,
        batchId,
      };
    }
    const acquired = await this.dependencies.coordinator.acquire(batchId);
    if (acquired.status !== 'acquired') {
      return {
        status: 'rejected',
        code: acquired.status === 'occupied'
          ? 'batch-occupied'
          : 'coordination-unavailable',
        batchId,
      };
    }
    try {
      const inspection = await this.dependencies.coordinator.withRead(
        batchId,
        () => this.dependencies.history.inspect(batchId),
      );
      if (!inspection) {
        return {
          status: 'rejected',
          code: 'batch-not-found',
          batchId,
        };
      }
      if (inspection.integrity !== 'complete') {
        return {
          status: 'rejected',
          code: 'partial-history',
          batchId,
        };
      }
      if (!inspection.batch.rerunnable) {
        return {
          status: 'rejected',
          code: 'results-only',
          batchId,
        };
      }
      const files: File[] = [];
      for (const item of [...inspection.batch.items]
        .sort((left, right) => left.order - right.order)) {
        if (!item.original) throw new Error(`Missing original asset for ${item.id}`);
        const blob = await this.dependencies.history.readAsset(item.original);
        if (!blob) throw new Error(`Missing or corrupt original asset: ${item.original.fileName}`);
        files.push(new File([blob], item.original.fileName, {
          type: item.original.mediaType,
          lastModified: new Date(inspection.batch.createdAt).getTime(),
        }));
      }
      const providerSelectionRequired = !isKnownTranslationProviderId(
        inspection.batch.lockedConfig.provider.id,
      );
      await this.dependencies.workbench.installDraft({
        kind: 'draft',
        sourceBatch: inspection.batch,
        files,
        providerSelectionRequired,
      });
      await this.refresh();
      return {
        status: 'succeeded',
        type: 'draft-prepared',
        batchId,
        providerSelectionRequired,
      };
    } catch (error) {
      const cause = messageFor(error);
      this.state = {
        ...this.state,
        failure: {
          operation: 'prepare-clone',
          cause,
        },
      };
      this.emit();
      return {
        status: 'failed',
        operation: 'prepare-clone',
        cause,
      };
    } finally {
      acquired.claim.release();
    }
  }

  private async stageDelete(batchId: string): Promise<HistoryOutcome> {
    if (this.pendingOperation) {
      return {
        status: 'rejected',
        code: 'pending-operation',
        batchId,
      };
    }
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.delete.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.delete.code,
        batchId,
      };
    }
    const acquired = await this.dependencies.coordinator.acquire(batchId);
    if (acquired.status !== 'acquired') {
      return {
        status: 'rejected',
        code: acquired.status === 'occupied'
          ? 'batch-occupied'
          : 'coordination-unavailable',
        batchId,
      };
    }
    const expiresAt = new Date(this.clock.now().getTime() + 10_000).toISOString();
    const pending: PendingHistoryOperation = {
      type: 'delete' as const,
      batchId,
      claim: acquired.claim,
      cancel: () => undefined,
    };
    pending.cancel = this.scheduler.schedule(
      10_000,
      () => this.enqueue(() => this.commitPending(pending)),
    );
    this.pendingOperation = pending;
    this.state = {
      ...this.state,
      pending: {
        type: 'delete',
        batchId,
        expiresAt,
      },
    };
    this.emit();
    return {
      status: 'succeeded',
      type: 'pending-staged',
      operation: 'delete',
      batchId,
    };
  }

  private async stageKeepResultsOnly(batchId: string): Promise<HistoryOutcome> {
    if (this.pendingOperation) {
      return {
        status: 'rejected',
        code: 'pending-operation',
        batchId,
      };
    }
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.keepResultsOnly.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.keepResultsOnly.code,
        batchId,
      };
    }
    const acquired = await this.dependencies.coordinator.acquire(batchId);
    if (acquired.status !== 'acquired') {
      return {
        status: 'rejected',
        code: acquired.status === 'occupied'
          ? 'batch-occupied'
          : 'coordination-unavailable',
        batchId,
      };
    }
    const expiresAt = new Date(this.clock.now().getTime() + 10_000).toISOString();
    const pending: PendingHistoryOperation = {
      type: 'keep-results-only',
      batchId,
      claim: acquired.claim,
      cancel: () => undefined,
    };
    pending.cancel = this.scheduler.schedule(
      10_000,
      () => this.enqueue(() => this.commitPending(pending)),
    );
    this.pendingOperation = pending;
    this.state = {
      ...this.state,
      pending: {
        type: 'keep-results-only',
        batchId,
        expiresAt,
      },
    };
    this.emit();
    return {
      status: 'succeeded',
      type: 'pending-staged',
      operation: 'keep-results-only',
      batchId,
    };
  }

  private async undoPending(): Promise<HistoryOutcome> {
    const pending = this.pendingOperation;
    if (!pending) {
      return {
        status: 'rejected',
        code: 'pending-operation',
      };
    }
    pending.cancel();
    pending.claim.release();
    this.pendingOperation = undefined;
    this.state = {
      ...this.state,
      pending: undefined,
    };
    this.dependencies.coordinator.publish(pending.batchId);
    await this.refresh();
    return {
      status: 'succeeded',
      type: 'pending-undone',
      batchId: pending.batchId,
    };
  }

  private async commitPending(
    pending: PendingHistoryOperation,
  ): Promise<void> {
    if (this.pendingOperation !== pending || this.disposed) return;
    try {
      await this.dependencies.coordinator.withWrite(
        pending.batchId,
        () => pending.type === 'delete'
          ? this.dependencies.history.deleteBatch(pending.batchId)
          : this.dependencies.history.keepResultsOnly(pending.batchId).then(() => undefined),
      );
      this.dependencies.coordinator.publish(pending.batchId);
    } catch (error) {
      this.state = {
        ...this.state,
        failure: {
          operation: pending.type,
          cause: messageFor(error),
        },
      };
    } finally {
      pending.claim.release();
      if (this.pendingOperation === pending) this.pendingOperation = undefined;
      this.state = {
        ...this.state,
        pending: undefined,
      };
      await this.refresh();
    }
  }

  private async exportProject(batchId: string): Promise<HistoryOutcome> {
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.exportProject.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.exportProject.code,
        batchId,
      };
    }
    try {
      const artifact = await this.dependencies.coordinator.withRead(batchId, async () => {
        const inspection = await this.dependencies.history.inspect(batchId);
        if (!inspection) throw new Error(`Local history batch not found: ${batchId}`);
        const blob = await buildProjectPackage(
          inspection,
          (reference) => this.dependencies.history.readAsset(reference),
        );
        return {
          kind: 'project' as const,
          blob,
          fileName: `${inspection.batch.createdAt.slice(0, 10)}-`
            + `${inspection.batch.id.slice(0, 8)}.shinobu.zip`,
        };
      });
      return {
        status: 'succeeded',
        type: 'artifact-ready',
        artifact,
      };
    } catch (error) {
      return this.failed('export-project', error);
    }
  }

  private async importProject(file: File): Promise<HistoryOutcome> {
    try {
      const validated = await validateProjectPackage(file);
      const imported = await this.dependencies.coordinator.withWrite(
        'project-import',
        () => this.dependencies.history.importBatch(
          validated.manifest.batch,
          validated.assets,
        ),
      );
      this.dependencies.coordinator.publish(imported.id);
      await this.refresh();
      return {
        status: 'succeeded',
        type: 'project-imported',
        batchId: imported.id,
      };
    } catch (error) {
      return this.failed('import-project', error);
    }
  }

  private async downloadResult(batchId: string, itemId: string): Promise<HistoryOutcome> {
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    const item = current?.batch.items.find((candidate) => candidate.id === itemId);
    if (!current || !item?.result) {
      return {
        status: 'rejected',
        code: 'result-unavailable',
        batchId,
      };
    }
    try {
      const blob = await this.dependencies.coordinator.withRead(
        batchId,
        () => this.dependencies.history.readAsset(item.result!),
      );
      if (!blob) {
        return {
          status: 'rejected',
          code: 'result-unavailable',
          batchId,
        };
      }
      return {
        status: 'succeeded',
        type: 'artifact-ready',
        artifact: {
          kind: 'result',
          blob,
          fileName: item.result.fileName,
        },
      };
    } catch (error) {
      return this.failed('download-result', error);
    }
  }

  private async exportResults(batchId: string): Promise<HistoryOutcome> {
    const current = this.state.entries.find((entry) => entry.batch.id === batchId);
    if (!current) {
      return {
        status: 'rejected',
        code: 'batch-not-found',
        batchId,
      };
    }
    if (!current.eligibility.exportResults.allowed) {
      return {
        status: 'rejected',
        code: current.eligibility.exportResults.code,
        batchId,
      };
    }
    try {
      const result = await this.dependencies.coordinator.withRead(batchId, async () => {
        const inspection = await this.dependencies.history.inspect(batchId);
        if (!inspection) throw new Error(`Local history batch not found: ${batchId}`);
        return {
          inspection,
          archive: await buildResultsZip(
            inspection,
            (reference) => this.dependencies.history.readAsset(reference),
          ),
        };
      });
      return {
        status: 'succeeded',
        type: 'artifact-ready',
        artifact: {
          kind: 'results',
          blob: result.archive.archive,
          fileName: `${result.inspection.batch.createdAt.slice(0, 10)}-`
            + 'shinobu-results.zip',
          exportedCount: result.archive.exportedCount,
          omissions: result.archive.omissions,
        },
      };
    } catch (error) {
      return this.failed('export-results', error);
    }
  }

  private async releaseRecovery(
    batchId: string,
    discardWorkbench: boolean,
  ): Promise<HistoryOutcome> {
    const recovery = this.recoveryClaim;
    if (!recovery || recovery.batchId !== batchId) {
      return {
        status: 'rejected',
        code: 'recovery-not-prepared',
        batchId,
      };
    }
    if (discardWorkbench) this.dependencies.workbench.discardRecovery(batchId);
    recovery.claim.release();
    this.recoveryClaim = undefined;
    this.dependencies.coordinator.publish(batchId);
    await this.refresh();
    return {
      status: 'succeeded',
      type: discardWorkbench ? 'recovery-discarded' : 'recovery-handed-off',
      batchId,
    };
  }

  private async retryCleanup(): Promise<HistoryOutcome> {
    try {
      const [faults, occupied] = await Promise.all([
        this.dependencies.history.listCleanupFaults(),
        this.dependencies.coordinator.occupiedBatchIds(),
      ]);
      for (const batchId of new Set(faults.map((fault) => fault.batchId))) {
        if (occupied.has(batchId)) continue;
        const acquired = await this.dependencies.coordinator.acquire(batchId);
        if (acquired.status !== 'acquired') continue;
        try {
          await this.dependencies.coordinator.withWrite(
            batchId,
            () => this.dependencies.history.retryCleanup(batchId),
          );
          this.dependencies.coordinator.publish(batchId);
        } finally {
          acquired.claim.release();
        }
      }
      await this.refresh();
      return {
        status: 'succeeded',
        type: 'cleanup-retried',
      };
    } catch (error) {
      return this.failed('retry-cleanup', error);
    }
  }

  private failed(operation: string, error: unknown): HistoryOutcome {
    const cause = messageFor(error);
    this.state = {
      ...this.state,
      failure: {
        operation,
        cause,
      },
    };
    this.emit();
    return {
      status: 'failed',
      operation,
      cause,
    };
  }
}

export function createLocalHistoryLifecycle(
  dependencies: LocalHistoryLifecycleDependencies,
): LocalHistoryLifecycle {
  return new LocalHistoryLifecycleImplementation(dependencies);
}
