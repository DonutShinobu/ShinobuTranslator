import {
  createWebSettingsDraftFromLockedConfig,
  restoreWebSettingsFromLockedConfig,
  type WebSettings,
} from '@shinobu/shared-config';
import type { PipelineProgress } from '@shinobu/image-pipeline';

import { describeImportRejection, getCopy } from '../../i18n';
import type { ContinuousCameraRoundState } from '../camera/cameraRound';
import type { LocalHistoryBatch, LocalHistoryVersions } from '../history/localHistory';
import type {
  HistoryIntent,
  HistoryOutcome,
  LocalHistoryLifecycle,
  LocalHistorySnapshot,
  LocalHistoryWorkbenchAdapter,
} from '../history/localHistoryLifecycle';
import type {
  ImageImporter,
  ImageImportRejection,
  ImportedImage,
} from '../import/imageImporter';
import type {
  ProcessingBatch,
  ProcessingBatchCommand,
  ProcessingBatchCommandResult,
  ProcessingBatchCredential,
  ProcessingBatchSnapshot,
  ProcessingBatchWorkspace,
  ProcessingTaskSnapshot,
} from '../processing/processingBatch';
import type {
  ProcessingRuntimeCredentialStatus,
  ProcessingRuntime,
  ProcessingRuntimeCommand,
  ProcessingRuntimeDecision,
  ProcessingRuntimeSnapshot,
} from '../processing/processingRuntime';
import {
  assessImageImportStorage,
  formatByteSize,
} from '../storage/storageBudget';

export type WebWorkbenchPhase = 'empty' | 'draft' | 'recovery' | 'processing';

type WebWorkbenchRuntimeCommand = Exclude<
  ProcessingRuntimeCommand,
  { type: 'dispose' }
>;

export type QueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type QueueJobState = {
  status: QueueJobStatus;
  progress?: PipelineProgress;
  resultUrl?: string;
  resultBlob?: Blob;
  error?: string;
  errorCode?: string;
};

export type WebWorkbenchSnapshot = {
  phase: WebWorkbenchPhase;
  settings: WebSettings;
  images: readonly ImportedImage[];
  selectedImageId: string | null;
  selectedPreviewUrl?: string;
  jobs: Readonly<Record<string, QueueJobState>>;
  importing: boolean;
  rejections: readonly ImageImportRejection[];
  activeBatch?: ProcessingBatchSnapshot;
  recoveryBatchId?: string;
  draftProviderSelectionRequired: boolean;
  notice: string;
  storageImportError?: string;
  history?: LocalHistorySnapshot;
  processingRuntime?: ProcessingRuntimeSnapshot;
  runtimeDecisions: Partial<Record<'queue' | 'camera', ProcessingRuntimeDecision>>;
  camera: {
    open: boolean;
    round: ContinuousCameraRoundState;
  };
};

export type WebWorkbenchIntent =
  | {
      type: 'import-files';
      files: readonly File[];
    }
  | {
      type: 'update-settings';
      settings: WebSettings;
    }
  | {
      type: 'select-image';
      imageId: string | null;
    }
  | {
      type: 'remove-image';
      imageId: string;
    }
  | {
      type: 'move-image';
      imageId: string;
      direction: -1 | 1;
    }
  | {
      type: 'start-processing';
      credential: ProcessingBatchCredential;
    }
  | {
      type: 'assess-runtime';
      target: 'queue' | 'camera';
      credential: ProcessingRuntimeCredentialStatus;
      pendingOriginalBytes: number;
    }
  | {
      type: 'runtime-command';
      command: WebWorkbenchRuntimeCommand;
    }
  | {
      type: 'batch-command';
      command: ProcessingBatchCommand;
    }
  | {
      type: 'open-camera';
      credential: ProcessingBatchCredential;
    }
  | { type: 'capture-camera'; file: File }
  | { type: 'next-camera' }
  | { type: 'close-camera' }
  | {
      type: 'history';
      intent: HistoryIntent;
    }
  | { type: 'exit-recovery' }
  | { type: 'visibility-hidden' }
  | { type: 'clear-notice' }
  | { type: 'clear-rejections' }
  | {
      type: 'set-notice';
      notice: string;
    };

export type WebWorkbenchDispatchResult =
  | HistoryOutcome
  | ProcessingBatchCommandResult
  | undefined;

export type WebWorkbench = {
  snapshot(): WebWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(intent: WebWorkbenchIntent): Promise<WebWorkbenchDispatchResult>;
  dispose(): Promise<void>;
};

type WebWorkbenchUrls = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

export type WebWorkbenchRuntime = {
  lifecycle: LocalHistoryLifecycle;
  processing: ProcessingBatchWorkspace;
  processingRuntime: ProcessingRuntime;
  dispose(): void;
};

type CreateWebWorkbenchOptions = {
  initialSettings: WebSettings;
  importer: () => ImageImporter;
  createRuntime: (adapter: LocalHistoryWorkbenchAdapter) => WebWorkbenchRuntime;
  versions: LocalHistoryVersions;
  onSettingsChanged?: (next: WebSettings, previous: WebSettings) => void;
  onProcessingCompleted?: () => void;
  urls?: WebWorkbenchUrls;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(snapshot: ProcessingBatchSnapshot): boolean {
  return snapshot.status === 'completed'
    || snapshot.status === 'partially-completed'
    || snapshot.status === 'failed';
}

function processingSettingsChanged(left: WebSettings, right: WebSettings): boolean {
  const providerId = left.translationProviderId;
  return left.schemaVersion !== right.schemaVersion
    || left.targetLanguage !== right.targetLanguage
    || left.processMode !== right.processMode
    || left.translationProviderId !== right.translationProviderId
    || JSON.stringify(left.providerProfiles[providerId])
      !== JSON.stringify(right.providerProfiles[providerId]);
}

export function createWebWorkbench({
  initialSettings,
  importer,
  createRuntime,
  versions,
  onSettingsChanged,
  onProcessingCompleted,
  urls = URL,
}: CreateWebWorkbenchOptions): WebWorkbench {
  const listeners = new Set<() => void>();
  let disposed = false;
  let disposalRequested = false;
  let commandTail = Promise.resolve<void>(undefined);
  let activeBatch: ProcessingBatch | undefined;
  let activeBatchToken = 0;
  let unsubscribeBatch: (() => void) | undefined;
  let unsubscribeHistory: (() => void) | undefined;
  let unsubscribeProcessingRuntime: (() => void) | undefined;
  let recoveryBatch: LocalHistoryBatch | undefined;
  let preRecoverySettings: WebSettings | undefined;
  let cameraRoundToken = 0;
  let runtime: WebWorkbenchRuntime | undefined;
  let runtimeInitialized = false;
  let processingWorkspace: ProcessingBatchWorkspace | undefined;
  let current: WebWorkbenchSnapshot = {
    phase: 'empty',
    settings: structuredClone(initialSettings),
    images: [],
    selectedImageId: null,
    jobs: {},
    importing: false,
    rejections: [],
    draftProviderSelectionRequired: false,
    notice: '',
    runtimeDecisions: {},
    camera: {
      open: false,
      round: { status: 'ready' },
    },
  };

  const publish = (patch: Partial<WebWorkbenchSnapshot>): void => {
    if (disposed) return;
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  };

  const releaseJob = (job: QueueJobState | undefined): void => {
    if (job?.resultUrl) urls.revokeObjectURL(job.resultUrl);
  };

  const releaseImages = (images: readonly ImportedImage[]): void => {
    for (const image of images) urls.revokeObjectURL(image.thumbnailUrl);
  };

  const releaseCameraRound = (): void => {
    const round = current.camera.round;
    if (round.status === 'ready') return;
    if (round.originalUrl) urls.revokeObjectURL(round.originalUrl);
    if (round.status === 'done') urls.revokeObjectURL(round.resultUrl);
  };

  const resetCameraRound = (): void => {
    cameraRoundToken += 1;
    releaseCameraRound();
    publish({ camera: { ...current.camera, round: { status: 'ready' } } });
  };

  const releaseContent = (): void => {
    if (current.selectedPreviewUrl) urls.revokeObjectURL(current.selectedPreviewUrl);
    releaseImages(current.images);
    for (const job of Object.values(current.jobs)) releaseJob(job);
  };

  const selectImage = (imageId: string | null): void => {
    if (imageId !== null && !current.images.some((image) => image.id === imageId)) return;
    if (imageId === current.selectedImageId) return;
    if (current.selectedPreviewUrl) urls.revokeObjectURL(current.selectedPreviewUrl);
    const selected = current.images.find((image) => image.id === imageId);
    publish({
      selectedImageId: imageId,
      selectedPreviewUrl: selected ? urls.createObjectURL(selected.file) : undefined,
    });
  };

  const changeSettings = (settings: WebSettings): void => {
    const previous = current.settings;
    publish({ settings: structuredClone(settings) });
    onSettingsChanged?.(settings, previous);
  };

  const installWorkbenchState = (input: {
    phase: 'empty' | 'draft' | 'recovery';
    settings: WebSettings;
    images: readonly ImportedImage[];
    jobs: Readonly<Record<string, QueueJobState>>;
    selectedImageId: string | null;
    recoveryBatchId?: string;
    draftProviderSelectionRequired: boolean;
    notice: string;
  }): void => {
    const previous = current.settings;
    releaseContent();
    const selected = input.images.find((image) => image.id === input.selectedImageId);
    publish({
      phase: input.phase,
      settings: structuredClone(input.settings),
      images: [...input.images],
      jobs: { ...input.jobs },
      selectedImageId: input.selectedImageId,
      selectedPreviewUrl: selected ? urls.createObjectURL(selected.file) : undefined,
      recoveryBatchId: input.recoveryBatchId,
      draftProviderSelectionRequired: input.draftProviderSelectionRequired,
      rejections: [],
      notice: input.notice,
    });
    onSettingsChanged?.(input.settings, previous);
  };

  const projectTask = (
    task: ProcessingTaskSnapshot,
    previous: QueueJobState | undefined,
  ): QueueJobState => {
    let resultUrl = previous?.resultUrl;
    if (task.result && previous?.resultBlob !== task.result.image) {
      if (resultUrl) urls.revokeObjectURL(resultUrl);
      resultUrl = urls.createObjectURL(task.result.image);
    }
    return {
      status: task.status,
      progress: task.progress,
      resultUrl,
      resultBlob: task.result?.image ?? previous?.resultBlob,
      error: task.error,
      errorCode: task.errorCode,
    };
  };

  const handleBatchSnapshot = (
    batch: ProcessingBatch,
    token: number,
    snapshot: ProcessingBatchSnapshot,
  ): void => {
    if (disposed || activeBatch !== batch || activeBatchToken !== token) return;
    const jobs = { ...current.jobs };
    if (snapshot.kind === 'queue') {
      for (const task of snapshot.tasks) {
        jobs[task.id] = projectTask(task, jobs[task.id]);
      }
    }
    const copy = getCopy(current.settings.uiLocale);
    let notice = current.notice;
    if (snapshot.persistence.status === 'faulted') {
      notice = `${copy.historyStorageError}: ${snapshot.persistence.error}`;
    } else if (snapshot.execution.status === 'faulted') {
      notice = snapshot.execution.error;
    }
    publish({ activeBatch: snapshot, jobs, notice });

    if (
      snapshot.kind === 'queue'
      && snapshot.status === 'running'
      && snapshot.input === 'open'
      && !current.importing
      && !snapshot.tasks.some((task) => task.status === 'queued' || task.status === 'running')
    ) {
      void batch.dispatch({ type: 'close-input' }).catch((error) => {
        if (activeBatch === batch && activeBatchToken === token) {
          publish({ notice: messageFor(error) });
        }
      });
    }

    if (isTerminal(snapshot)) {
      unsubscribeBatch?.();
      unsubscribeBatch = undefined;
      activeBatch = undefined;
      activeBatchToken += 1;
      publish({
        phase: current.images.length > 0 ? 'draft' : 'empty',
        activeBatch: undefined,
        recoveryBatchId: undefined,
      });
      void runtime?.lifecycle.request({ type: 'refresh' });
      void runtime?.processingRuntime.dispatch({ type: 'refresh-storage' }).catch((error) => {
        publish({ notice: messageFor(error) });
      });
      if (snapshot.tasks.some((task) => task.status === 'done')) {
        onProcessingCompleted?.();
      }
    }
  };

  const attachBatch = (batch: ProcessingBatch): void => {
    unsubscribeBatch?.();
    activeBatch = batch;
    const token = ++activeBatchToken;
    publish({
      phase: 'processing',
      activeBatch: batch.snapshot(),
      recoveryBatchId: batch.snapshot().id,
    });
    const unsubscribe = batch.subscribe((snapshot) => {
      handleBatchSnapshot(batch, token, snapshot);
    });
    if (activeBatch === batch && activeBatchToken === token) {
      unsubscribeBatch = unsubscribe;
    } else {
      unsubscribe();
    }
  };

  const historyAdapter: LocalHistoryWorkbenchAdapter = {
    occupied: () => current.phase !== 'empty',
    async installRecovery(preparation) {
      const imageImporter = importer();
      const orderedItems = [...preparation.batch.items]
        .sort((left, right) => left.order - right.order);
      const imported = await imageImporter.importFiles(preparation.files, []);
      if (imported.accepted.length !== orderedItems.length) {
        releaseImages(imported.accepted);
        throw new Error(getCopy(current.settings.uiLocale).historyOriginalValidationFailed);
      }
      const settings = restoreWebSettingsFromLockedConfig(
        preparation.batch.lockedConfig,
        current.settings,
      );
      if (!settings) {
        releaseImages(imported.accepted);
        throw new Error(getCopy(current.settings.uiLocale).historyProviderUnavailable);
      }
      const images = imported.accepted.map((image, index) => ({
        ...image,
        id: orderedItems[index].id,
      }));
      const copy = getCopy(settings.uiLocale);
      const jobs = Object.fromEntries(orderedItems.map((item) => [
        item.id,
        item.status === 'done'
          ? {
              status: 'done' as const,
              progress: {
                stage: 'done' as const,
                operation: 'restore-history',
                detail: copy.historyRecoveryLoadedDetail,
              },
            }
          : {
              status: item.status === 'running' ? 'queued' as const : item.status,
              error: item.error,
            },
      ]));
      preRecoverySettings = structuredClone(current.settings);
      recoveryBatch = preparation.batch;
      installWorkbenchState({
        phase: 'recovery',
        settings,
        images,
        jobs,
        selectedImageId: preparation.batch.items.find((item) => item.status !== 'done')?.id
          ?? preparation.batch.items[0]?.id
          ?? null,
        recoveryBatchId: preparation.batch.id,
        draftProviderSelectionRequired: false,
        notice: copy.historyResumeReady,
      });
    },
    async installDraft(preparation) {
      const imageImporter = importer();
      const imported = await imageImporter.importFiles(preparation.files, []);
      if (imported.accepted.length !== preparation.files.length) {
        releaseImages(imported.accepted);
        throw new Error(getCopy(current.settings.uiLocale).historyOriginalValidationFailed);
      }
      const draft = createWebSettingsDraftFromLockedConfig(
        preparation.sourceBatch.lockedConfig,
        current.settings,
      );
      preRecoverySettings = undefined;
      recoveryBatch = undefined;
      const copy = getCopy(draft.settings.uiLocale);
      installWorkbenchState({
        phase: imported.accepted.length > 0 ? 'draft' : 'empty',
        settings: draft.settings,
        images: imported.accepted,
        jobs: {},
        selectedImageId: imported.accepted[0]?.id ?? null,
        recoveryBatchId: undefined,
        draftProviderSelectionRequired: draft.providerSelectionRequired,
        notice: draft.providerSelectionRequired
          ? copy.historyProviderSelectionRequired
          : '',
      });
    },
    discardRecovery(batchId) {
      if (recoveryBatch?.id !== batchId) return;
      const previous = current.settings;
      const settings = preRecoverySettings ?? current.settings;
      releaseContent();
      preRecoverySettings = undefined;
      recoveryBatch = undefined;
      publish({
        phase: 'empty',
        settings: structuredClone(settings),
        images: [],
        jobs: {},
        selectedImageId: null,
        selectedPreviewUrl: undefined,
        recoveryBatchId: undefined,
        draftProviderSelectionRequired: false,
        rejections: [],
        notice: '',
      });
      if (settings !== previous) onSettingsChanged?.(settings, previous);
    },
  };

  const initializeRuntime = (): void => {
    if (runtimeInitialized || disposed || disposalRequested) return;
    runtimeInitialized = true;
    runtime = createRuntime(historyAdapter);
    processingWorkspace = runtime.processing;
    current = {
      ...current,
      history: runtime.lifecycle.snapshot(),
      processingRuntime: runtime.processingRuntime.snapshot(),
    };
    unsubscribeHistory = runtime.lifecycle.subscribe(() => {
      publish({ history: runtime?.lifecycle.snapshot() });
    });
    unsubscribeProcessingRuntime = runtime.processingRuntime.subscribe(() => {
      publish({ processingRuntime: runtime?.processingRuntime.snapshot() });
    });
    void runtime.processingRuntime.dispatch({ type: 'refresh' }).catch((error) => {
      publish({ notice: messageFor(error) });
    });
  };

  const addImages = async (images: readonly ImportedImage[]): Promise<void> => {
    if (images.length === 0) return;
    if (current.phase === 'recovery') {
      throw new Error(getCopy(current.settings.uiLocale).historyResumeReady);
    }
    if (activeBatch) {
      try {
        await activeBatch.dispatch({ type: 'append', images });
      } catch (error) {
        releaseImages(images);
        throw error;
      }
    }
    const nextImages = [...current.images, ...images];
    const jobs = { ...current.jobs };
    if (activeBatch) {
      for (const image of images) jobs[image.id] = { status: 'queued' };
    }
    const selectedImageId = current.selectedImageId ?? images[0].id;
    const selectedPreviewUrl = current.selectedImageId
      ? current.selectedPreviewUrl
      : urls.createObjectURL(images[0].file);
    publish({
      phase: activeBatch ? 'processing' : 'draft',
      images: nextImages,
      jobs,
      selectedImageId,
      selectedPreviewUrl,
      storageImportError: undefined,
    });
  };

  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    if (current.phase === 'recovery') {
      publish({ notice: getCopy(current.settings.uiLocale).historyResumeReady });
      return;
    }
    const imageImporter = importer();
    publish({ importing: true });
    try {
      const imported = await imageImporter.importFiles(files, current.images);
      let accepted = imported.accepted;
      if (accepted.length > 0 && runtime) {
        const pendingOriginalBytes = (
          (activeBatch ? 0 : current.images.reduce((sum, image) => sum + image.file.size, 0))
          + accepted.reduce((sum, image) => sum + image.file.size, 0)
        );
        await runtime.processingRuntime.dispatch({ type: 'refresh-storage' });
        const storage = runtime.processingRuntime.snapshot().storage;
        const admission = storage.status === 'checking'
          ? { allowed: false as const, reason: 'unavailable' as const }
          : assessImageImportStorage(storage, pendingOriginalBytes);
        if (!admission.allowed) {
          releaseImages(accepted);
          accepted = [];
          const copy = getCopy(current.settings.uiLocale);
          const message = admission.reason === 'unavailable'
            ? copy.storageUnavailable
            : copy.storageImportBlocked(
                formatByteSize(admission.requiredBytes),
                formatByteSize(admission.availableBytes ?? 0),
              );
          publish({ storageImportError: message, notice: message });
        }
      }
      await addImages(accepted);
      if (imported.rejected.length > 0) {
        publish({ rejections: [...current.rejections, ...imported.rejected] });
      }
    } finally {
      publish({ importing: false });
      const snapshot = activeBatch?.snapshot();
      if (
        activeBatch
        && snapshot?.kind === 'queue'
        && snapshot.status === 'running'
        && snapshot.input === 'open'
        && !snapshot.tasks.some((task) => task.status === 'queued' || task.status === 'running')
      ) {
        void activeBatch.dispatch({ type: 'close-input' }).catch(() => undefined);
      }
    }
  };

  const startProcessing = async (
    credential: ProcessingBatchCredential,
    kind: 'queue' | 'continuous-camera' = 'queue',
  ): Promise<void> => {
    if (activeBatch) {
      const snapshot = activeBatch.snapshot();
      if (snapshot.status === 'paused' && snapshot.persistence.status === 'healthy') {
        await activeBatch.dispatch({ type: 'resume' });
        publish({ notice: '' });
      } else if (snapshot.persistence.status === 'faulted') {
        publish({
          notice: `${getCopy(current.settings.uiLocale).historyStorageError}: `
            + snapshot.persistence.error,
        });
      }
      return;
    }
    if (!processingWorkspace) throw new Error('Processing workspace is unavailable');
    if (kind === 'queue' && (current.images.length === 0 || current.importing)) return;
    const jobs = { ...current.jobs };
    if (kind === 'queue') {
      for (const image of current.images) {
        const previous = jobs[image.id];
        if (
          current.phase === 'recovery'
          && previous
          && (previous.status === 'done'
            || previous.status === 'failed'
            || previous.status === 'cancelled')
        ) {
          continue;
        }
        jobs[image.id] = { status: 'queued' };
      }
    }
    let unattachedBatch: ProcessingBatch | undefined;
    try {
      let batch: ProcessingBatch;
      if (current.phase === 'recovery') {
        if (!recoveryBatch || recoveryBatch.id !== current.recoveryBatchId) {
          throw new Error('恢复处理批次的本地历史上下文已失效');
        }
        batch = await processingWorkspace.resume({
          batch: recoveryBatch,
          images: current.images,
          settings: current.settings,
          inputLifetime: 'until-closed',
          credential,
        });
        unattachedBatch = batch;
        const outcome = await runtime?.lifecycle.request({
          type: 'handoff-recovery',
          batchId: recoveryBatch.id,
        });
        if (!outcome || outcome.status !== 'succeeded') {
          throw new Error(!outcome
            ? 'Recovery handoff is unavailable'
            : outcome.status === 'failed' ? outcome.cause : outcome.code);
        }
        recoveryBatch = undefined;
        preRecoverySettings = undefined;
      } else {
        batch = await processingWorkspace.open({
          kind,
          inputLifetime: kind === 'queue' ? 'until-closed' : undefined,
          initialImages: kind === 'queue' ? current.images : [],
          settings: current.settings,
          versions,
          credential,
        });
        unattachedBatch = batch;
      }
      if (kind === 'queue') {
        for (const [id, previous] of Object.entries(current.jobs)) {
          if (previous !== jobs[id]) releaseJob(previous);
        }
      }
      publish({
        jobs: kind === 'queue' ? jobs : current.jobs,
        notice: '',
        draftProviderSelectionRequired: false,
      });
      attachBatch(batch);
      unattachedBatch = undefined;
    } catch (error) {
      if (unattachedBatch) {
        let stopCompleted = false;
        try {
          if (unattachedBatch.snapshot().status === 'running') {
            await unattachedBatch.dispatch({ type: 'stop' });
          }
          stopCompleted = true;
        } catch {
          // A persistence failure may still leave the batch paused and detachable.
        }
        let snapshot = unattachedBatch.snapshot();
        if (snapshot.status === 'running' && stopCompleted) {
          snapshot = await new Promise<ProcessingBatchSnapshot>((resolve) => {
            let unsubscribe = (): void => undefined;
            unsubscribe = unattachedBatch!.subscribe((next) => {
              if (next.status === 'running') return;
              queueMicrotask(() => unsubscribe());
              resolve(next);
            });
          });
        }
        if (snapshot.status === 'paused') {
          try {
            await unattachedBatch.dispatch({ type: 'detach' });
          } catch {
            // Preserve the original start failure after the best-effort detach.
          }
        }
      }
      publish({ notice: messageFor(error), activeBatch: undefined });
      throw error;
    }
  };

  const applyIntent = async (
    intent: WebWorkbenchIntent,
  ): Promise<WebWorkbenchDispatchResult> => {
    if (intent.type === 'import-files') {
      await importFiles(intent.files);
      return undefined;
    }
    if (intent.type === 'update-settings') {
      if (
        (current.phase === 'recovery' || current.phase === 'processing')
        && processingSettingsChanged(current.settings, intent.settings)
      ) return undefined;
      if (current.phase === 'recovery' && preRecoverySettings) {
        const lockedProviderId = current.settings.translationProviderId;
        const providerProfiles = structuredClone(preRecoverySettings.providerProfiles);
        for (const providerId of Object.keys(providerProfiles) as Array<
          keyof WebSettings['providerProfiles']
        >) {
          if (providerId !== lockedProviderId) {
            providerProfiles[providerId] = structuredClone(
              intent.settings.providerProfiles[providerId],
            );
          }
        }
        preRecoverySettings = {
          ...preRecoverySettings,
          uiLocale: intent.settings.uiLocale,
          providerProfiles,
        };
      }
      changeSettings(intent.settings);
      if (current.phase === 'draft' || current.phase === 'empty') {
        publish({ draftProviderSelectionRequired: false, notice: '' });
      }
      return undefined;
    }
    if (intent.type === 'select-image') {
      selectImage(intent.imageId);
      return undefined;
    }
    if (intent.type === 'remove-image') {
      const index = current.images.findIndex((image) => image.id === intent.imageId);
      if (index < 0 || current.importing || current.phase === 'recovery') return undefined;
      const job = current.jobs[intent.imageId];
      if (job?.status === 'running') return undefined;
      if (activeBatch) {
        if (job?.status !== 'queued') return undefined;
        await activeBatch.dispatch({ type: 'remove-queued', taskId: intent.imageId });
      }
      urls.revokeObjectURL(current.images[index].thumbnailUrl);
      releaseJob(job);
      const images = current.images.filter((image) => image.id !== intent.imageId);
      const jobs = { ...current.jobs };
      delete jobs[intent.imageId];
      const selectedImageId = current.selectedImageId === intent.imageId
        ? images[Math.min(index, images.length - 1)]?.id ?? null
        : current.selectedImageId;
      let selectedPreviewUrl = current.selectedPreviewUrl;
      if (current.selectedImageId === intent.imageId) {
        if (selectedPreviewUrl) urls.revokeObjectURL(selectedPreviewUrl);
        const selected = images.find((image) => image.id === selectedImageId);
        selectedPreviewUrl = selected ? urls.createObjectURL(selected.file) : undefined;
      }
      publish({
        phase: activeBatch ? 'processing' : images.length > 0 ? 'draft' : 'empty',
        images,
        jobs,
        selectedImageId,
        selectedPreviewUrl,
      });
      return undefined;
    }
    if (intent.type === 'move-image') {
      if (current.importing || current.phase === 'recovery') return undefined;
      const index = current.images.findIndex((image) => image.id === intent.imageId);
      const target = index + intent.direction;
      if (index < 0 || target < 0 || target >= current.images.length) return undefined;
      const targetId = current.images[target].id;
      if (
        current.jobs[intent.imageId]?.status === 'running'
        || current.jobs[targetId]?.status === 'running'
      ) return undefined;
      if (
        activeBatch
        && (current.jobs[intent.imageId]?.status !== 'queued'
          || current.jobs[targetId]?.status !== 'queued')
      ) return undefined;
      const images = [...current.images];
      [images[index], images[target]] = [images[target], images[index]];
      if (activeBatch) {
        await activeBatch.dispatch({
          type: 'reorder-queued',
          taskIds: images.map((image) => image.id),
        });
      }
      publish({ images });
      return undefined;
    }
    if (intent.type === 'start-processing') {
      await startProcessing(intent.credential);
      return undefined;
    }
    if (intent.type === 'assess-runtime') {
      if (!runtime) throw new Error('Processing runtime is unavailable');
      const decision = runtime.processingRuntime.assess({
        settings: current.settings,
        credential: intent.credential,
        pendingOriginalBytes: intent.pendingOriginalBytes,
      });
      publish({
        runtimeDecisions: {
          ...current.runtimeDecisions,
          [intent.target]: decision,
        },
      });
      return undefined;
    }
    if (intent.type === 'runtime-command') {
      if (!runtime) throw new Error('Processing runtime is unavailable');
      await runtime.processingRuntime.dispatch(intent.command);
      return undefined;
    }
    if (intent.type === 'batch-command') {
      if (!activeBatch) return undefined;
      const result = await activeBatch.dispatch(intent.command);
      if (intent.command.type === 'detach') {
        unsubscribeBatch?.();
        unsubscribeBatch = undefined;
        activeBatch = undefined;
        activeBatchToken += 1;
        recoveryBatch = undefined;
        publish({
          phase: current.images.length > 0 ? 'draft' : 'empty',
          activeBatch: undefined,
          recoveryBatchId: undefined,
          notice: '',
        });
      }
      return result;
    }
    if (intent.type === 'open-camera') {
      if (current.phase !== 'empty') {
        throw new Error('Continuous camera requires an empty workbench');
      }
      await startProcessing(intent.credential, 'continuous-camera');
      resetCameraRound();
      publish({ camera: { open: true, round: { status: 'ready' } } });
      return undefined;
    }
    if (intent.type === 'capture-camera') {
      const batch = activeBatch;
      if (!current.camera.open || !batch || batch.snapshot().kind !== 'continuous-camera') {
        throw new Error('Continuous camera batch is unavailable');
      }
      const token = ++cameraRoundToken;
      releaseCameraRound();
      const originalUrl = urls.createObjectURL(intent.file);
      const copy = getCopy(current.settings.uiLocale);
      publish({
        camera: {
          open: true,
          round: { status: 'preparing', originalUrl, detail: copy.importing },
        },
      });
      void (async (): Promise<void> => {
        try {
          const imageImporter = importer();
          const imported = await imageImporter.importFiles([intent.file], []);
          if (cameraRoundToken !== token) {
            releaseImages(imported.accepted);
            return;
          }
          const image = imported.accepted[0];
          if (!image) {
            const rejection = imported.rejected[0];
            throw new Error(rejection
              ? describeImportRejection(current.settings.uiLocale, rejection.code)
              : copy.cameraCaptureFailed);
          }
          publish({
            camera: {
              open: true,
              round: { status: 'translating', originalUrl, detail: copy.cameraTranslating },
            },
          });
          let task: ProcessingTaskSnapshot;
          try {
            await batch.dispatch({ type: 'append', images: [image] });
            task = await new Promise<ProcessingTaskSnapshot>((resolve, reject) => {
              let unsubscribe = (): void => undefined;
              unsubscribe = batch.subscribe((snapshot) => {
                if (activeBatch !== batch) {
                  queueMicrotask(() => unsubscribe());
                  reject(new Error('Continuous camera batch ended before the image completed'));
                  return;
                }
                const candidate = snapshot.tasks.find((item) => item.id === image.id);
                if (!candidate) return;
                if (candidate.status === 'running' && cameraRoundToken === token) {
                  publish({
                    camera: {
                      open: true,
                      round: {
                        status: 'translating',
                        originalUrl,
                        detail: candidate.progress?.detail ?? copy.cameraTranslating,
                      },
                    },
                  });
                }
                if (
                  candidate.status === 'done'
                  || candidate.status === 'failed'
                  || candidate.status === 'cancelled'
                ) {
                  queueMicrotask(() => unsubscribe());
                  resolve(candidate);
                }
              });
            });
          } finally {
            releaseImages([image]);
          }
          if (task.status !== 'done' || !task.result) {
            throw new Error(task.error ?? copy.cameraTranslationFailed);
          }
          const resultUrl = urls.createObjectURL(task.result.image);
          if (cameraRoundToken !== token) {
            urls.revokeObjectURL(resultUrl);
            return;
          }
          publish({
            camera: {
              open: true,
              round: { status: 'done', originalUrl, resultUrl },
            },
          });
          void runtime?.processingRuntime.dispatch({ type: 'refresh-storage' }).catch((error) => {
            publish({ notice: messageFor(error) });
          });
          onProcessingCompleted?.();
        } catch (error) {
          if (cameraRoundToken === token) {
            publish({
              camera: {
                open: true,
                round: { status: 'error', originalUrl, error: messageFor(error) },
              },
            });
          }
        }
      })();
      return undefined;
    }
    if (intent.type === 'next-camera') {
      resetCameraRound();
      return undefined;
    }
    if (intent.type === 'close-camera') {
      const batch = activeBatch;
      resetCameraRound();
      publish({ camera: { open: false, round: { status: 'ready' } } });
      if (batch?.snapshot().kind === 'continuous-camera') {
        if (batch.snapshot().input === 'open') {
          await batch.dispatch({ type: 'close-input' });
        }
        if (activeBatch === batch && batch.snapshot().status === 'paused') {
          return applyIntent({ type: 'batch-command', command: { type: 'detach' } });
        }
      }
      return undefined;
    }
    if (intent.type === 'history') {
      const outcome = await runtime!.lifecycle.request(intent.intent);
      if (outcome.status === 'succeeded' && outcome.type === 'project-imported') {
        void runtime!.processingRuntime.dispatch({ type: 'refresh-storage' }).catch((error) => {
          publish({ notice: messageFor(error) });
        });
      }
      return outcome;
    }
    if (intent.type === 'exit-recovery') {
      if (activeBatch?.snapshot().status === 'paused') {
        return applyIntent({ type: 'batch-command', command: { type: 'detach' } });
      }
      if (current.recoveryBatchId) {
        return runtime?.lifecycle.request({
          type: 'discard-recovery',
          batchId: current.recoveryBatchId,
        });
      }
      return undefined;
    }
    if (intent.type === 'visibility-hidden') {
      if (activeBatch?.snapshot().status === 'running') {
        return activeBatch.dispatch({ type: 'stop' });
      }
      return undefined;
    }
    if (intent.type === 'clear-notice') {
      publish({ notice: '' });
      return undefined;
    }
    if (intent.type === 'clear-rejections') {
      publish({ rejections: [] });
      return undefined;
    }
    publish({ notice: intent.notice });
    return undefined;
  };

  const workbench: WebWorkbench = {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      initializeRuntime();
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      if (disposed || disposalRequested) {
        return Promise.reject(new Error('Web workbench has been disposed.'));
      }
      initializeRuntime();
      if (
        intent.type === 'runtime-command'
        && intent.command.type === 'cancel-model-download'
      ) {
        return runtime!.processingRuntime.dispatch(intent.command).then(() => undefined);
      }
      const operation = commandTail.then(() => applyIntent(intent));
      commandTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async dispose() {
      if (disposed || disposalRequested) return;
      disposalRequested = true;
      cameraRoundToken += 1;
      const batch = activeBatch;
      const runtimeDisposal = runtime?.processingRuntime.dispatch({ type: 'dispose' })
        .catch(() => undefined) ?? Promise.resolve();
      const batchStop = batch?.snapshot().status === 'running'
        ? batch.dispatch({ type: 'stop' }).catch(() => undefined)
        : Promise.resolve();
      await Promise.all([commandTail, runtimeDisposal, batchStop]);
      unsubscribeBatch?.();
      unsubscribeHistory?.();
      unsubscribeProcessingRuntime?.();
      runtime?.dispose();
      releaseCameraRound();
      releaseContent();
      activeBatch = undefined;
      disposed = true;
      listeners.clear();
    },
  };

  return workbench;
}
