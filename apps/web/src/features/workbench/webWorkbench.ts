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
  LocalHistoryLifecycle,
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
import {
  projectWebWorkbench,
  projectWebWorkbenchHistory,
} from './webWorkbenchProjection';

export type WebWorkbenchPhase = 'empty' | 'draft' | 'recovery' | 'processing';

type WebWorkbenchRuntimeCommand = Exclude<
  ProcessingRuntimeCommand,
  { type: 'dispose' }
>;

export type QueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type WebWorkbenchAvailability =
  | { status: 'available' }
  | {
      status: 'blocked';
      reason: string;
      detail?: string;
      requiredBytes?: number;
      availableBytes?: number;
    };

export type WebWorkbenchPrimaryAction = {
  kind:
    | 'pick-images'
    | 'start-processing'
    | 'stop-processing'
    | 'open-storage-settings'
    | 'install-models'
    | 'retry-runtime'
    | 'open-provider-settings';
  availability: WebWorkbenchAvailability;
};

export type WebWorkbenchCameraEntryAction = {
  kind:
    | 'open-camera'
    | 'open-storage-settings'
    | 'open-provider-settings'
    | 'unavailable';
  availability: WebWorkbenchAvailability;
};

export type WebWorkbenchProviderView = {
  configuration: WebWorkbenchAvailability;
};

export type WebWorkbenchProcessingView = {
  status: 'idle' | ProcessingBatchSnapshot['status'];
  canStop: boolean;
  canCancelCurrent: boolean;
  canRetryTasks: boolean;
};

export type WebWorkbenchRuntimeView = {
  status: ProcessingRuntimeSnapshot['status'];
  environment: ProcessingRuntimeSnapshot['environment'];
  capability?: ProcessingRuntimeSnapshot['capability'];
  modelConsent: boolean;
  modelPackage: ProcessingRuntimeSnapshot['modelPackage'];
  modelProbe: ProcessingRuntimeSnapshot['modelProbe'];
  storage: ProcessingRuntimeSnapshot['storage'];
  queue: WebWorkbenchAvailability;
  camera: WebWorkbenchAvailability;
};

export type WebWorkbenchControls = {
  importImages: WebWorkbenchAvailability;
  editProcessingSettings: WebWorkbenchAvailability;
  openCamera: WebWorkbenchAvailability;
  exitRecovery: WebWorkbenchAvailability;
};

export type WebWorkbenchItemActions = {
  remove: WebWorkbenchAvailability;
  moveUp: WebWorkbenchAvailability;
  moveDown: WebWorkbenchAvailability;
  retry: WebWorkbenchAvailability;
};

export type WebWorkbenchDiagnosticSource = {
  settings: WebSettings;
  runtime: Pick<WebWorkbenchRuntimeView, 'capability' | 'modelPackage'>;
  jobs: readonly {
    status: QueueJobStatus;
    progress?: Pick<PipelineProgress, 'stage'>;
    errorCode?: string;
  }[];
  providerConfigurationValid: boolean;
};

export type WebWorkbenchHistoryArtifact =
  | { kind: 'project' | 'result'; blob: Blob; fileName: string }
  | {
      kind: 'results';
      blob: Blob;
      fileName: string;
      exportedCount: number;
      omissions: readonly {
        itemId: string;
        fileName: string;
        reason: 'missing-or-corrupt';
      }[];
    };

export type WebWorkbenchEffect =
  | {
      status: 'effect';
      effect: 'pick-images' | 'open-storage-settings' | 'open-provider-settings';
    }
  | {
      status: 'effect';
      effect: 'download-history-artifact';
      artifact: WebWorkbenchHistoryArtifact;
    }
  | {
      status: 'effect';
      effect: 'open-workbench';
      providerSelectionRequired: boolean;
    };

export type WebWorkbenchDiagnosticsAdapter = {
  export(source: WebWorkbenchDiagnosticSource): Promise<void>;
};

export type WebWorkbenchHistoryAction =
  | { type: 'refresh-history' }
  | { type: 'resume-history'; batchId: string }
  | { type: 'clone-history'; batchId: string }
  | { type: 'stage-history-delete'; batchId: string }
  | { type: 'keep-history-results'; batchId: string }
  | { type: 'export-history-project'; batchId: string }
  | { type: 'import-history-project'; file: File }
  | { type: 'download-history-result'; batchId: string; itemId: string }
  | { type: 'export-history-results'; batchId: string }
  | { type: 'retry-history-cleanup' }
  | { type: 'undo-history-action' };

export type WebWorkbenchHistoryRejectionCode =
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
export type WebWorkbenchHistoryActionState =
  | {
      status: 'rejected';
      code: WebWorkbenchHistoryRejectionCode;
      batchId?: string;
    }
  | { status: 'failed'; operation: string; cause: string };

export type WebWorkbenchHistoryAvailability =
  | { status: 'available' }
  | { status: 'blocked'; reason: WebWorkbenchHistoryRejectionCode };

export type WebWorkbenchHistoryEntry = {
  id: string;
  updatedAt: string;
  status: 'running' | 'paused' | 'completed' | 'partially-completed' | 'failed';
  rerunnable: boolean;
  itemCount: number;
  completedCount: number;
  integrity: 'complete' | 'partial';
  processing: {
    processMode: WebSettings['processMode'];
    targetLanguage: WebSettings['targetLanguage'];
    providerId: string;
    modelVersion: string;
  };
  items: readonly {
    id: string;
    order: number;
    width: number;
    height: number;
    status: QueueJobStatus;
    fileName?: string;
    error?: string;
    hasResult: boolean;
  }[];
  actions: {
    resume: WebWorkbenchHistoryAvailability;
    clone: WebWorkbenchHistoryAvailability;
    exportResults: WebWorkbenchHistoryAvailability;
    exportProject: WebWorkbenchHistoryAvailability;
    keepResultsOnly: WebWorkbenchHistoryAvailability;
    delete: WebWorkbenchHistoryAvailability;
  };
};

export type WebWorkbenchHistoryView = {
  status: 'loading' | 'ready';
  entries: readonly WebWorkbenchHistoryEntry[];
  busy: boolean;
  cleanup: { faultCount: number; unreleasedBytes: number };
  pending?: {
    type: 'delete' | 'keep-results-only';
    batchId: string;
    expiresAt: string;
  };
  failure?: { operation: string; cause: string };
};

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
  primaryAction: WebWorkbenchPrimaryAction;
  processing: WebWorkbenchProcessingView;
  runtime: WebWorkbenchRuntimeView;
  provider: WebWorkbenchProviderView;
  controls: WebWorkbenchControls;
  settings: WebSettings;
  images: readonly ImportedImage[];
  selectedImageId: string | null;
  selectedPreviewUrl?: string;
  jobs: Readonly<Record<string, QueueJobState>>;
  itemActions: Readonly<Record<string, WebWorkbenchItemActions>>;
  importing: boolean;
  rejections: readonly ImageImportRejection[];
  draftProviderSelectionRequired: boolean;
  notice: string;
  storageImportError?: string;
  history: WebWorkbenchHistoryView;
  historyAction?: WebWorkbenchHistoryActionState;
  diagnostics: { exporting: boolean };
  camera: {
    open: boolean;
    round: ContinuousCameraRoundState;
    entry: WebWorkbenchCameraEntryAction;
  };
};

export type WebWorkbenchIntent =
  | WebWorkbenchHistoryAction
  | { type: 'activate-primary' }
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
    }
  | { type: 'stop-processing' }
  | { type: 'resume-processing' }
  | { type: 'detach-processing' }
  | { type: 'cancel-current' }
  | { type: 'retry-task'; taskId: string }
  | { type: 'refresh-runtime' }
  | { type: 'refresh-storage' }
  | { type: 'install-models' }
  | { type: 'cancel-model-install' }
  | { type: 'retry-runtime' }
  | { type: 'export-diagnostics' }
  | { type: 'activate-camera-entry' }
  | { type: 'capture-camera'; file: File }
  | { type: 'next-camera' }
  | { type: 'close-camera' }
  | { type: 'exit-recovery' }
  | { type: 'visibility-hidden' }
  | { type: 'clear-rejections' };

export type WebWorkbenchDispatchResult =
  | WebWorkbenchEffect
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

export type WebWorkbenchCredentialAdapter = {
  status(settings: WebSettings): ProcessingRuntimeCredentialStatus;
  resolve(settings: WebSettings): ProcessingBatchCredential | null;
  subscribe(listener: () => void): () => void;
};

type CreateWebWorkbenchOptions = {
  initialSettings: WebSettings;
  importer: () => ImageImporter;
  credentials?: WebWorkbenchCredentialAdapter;
  diagnostics?: WebWorkbenchDiagnosticsAdapter;
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

function historyIntentFor(action: WebWorkbenchHistoryAction): HistoryIntent {
  switch (action.type) {
    case 'refresh-history':
      return { type: 'refresh' };
    case 'resume-history':
      return { type: 'prepare-resume', batchId: action.batchId };
    case 'clone-history':
      return { type: 'prepare-clone', batchId: action.batchId };
    case 'stage-history-delete':
      return { type: 'stage-delete', batchId: action.batchId };
    case 'keep-history-results':
      return { type: 'stage-keep-results-only', batchId: action.batchId };
    case 'export-history-project':
      return { type: 'export-project', batchId: action.batchId };
    case 'import-history-project':
      return { type: 'import-project', file: action.file };
    case 'download-history-result':
      return { type: 'download-result', batchId: action.batchId, itemId: action.itemId };
    case 'export-history-results':
      return { type: 'export-results', batchId: action.batchId };
    case 'retry-history-cleanup':
      return { type: 'retry-cleanup' };
    case 'undo-history-action':
      return { type: 'undo-pending' };
  }
}

function isHistoryAction(intent: WebWorkbenchIntent): intent is WebWorkbenchHistoryAction {
  return intent.type === 'refresh-history'
    || intent.type === 'resume-history'
    || intent.type === 'clone-history'
    || intent.type === 'stage-history-delete'
    || intent.type === 'keep-history-results'
    || intent.type === 'export-history-project'
    || intent.type === 'import-history-project'
    || intent.type === 'download-history-result'
    || intent.type === 'export-history-results'
    || intent.type === 'retry-history-cleanup'
    || intent.type === 'undo-history-action';
}

export function createWebWorkbench({
  initialSettings,
  importer,
  credentials = {
    status: (settings) => {
      const providerId = settings.translationProviderId;
      return {
        providerId,
        target: settings.providerProfiles[providerId].baseUrl,
        available: false,
      };
    },
    resolve: () => null,
    subscribe: () => () => undefined,
  },
  diagnostics,
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
  let unsubscribeCredentials: (() => void) | undefined;
  let recoveryBatch: LocalHistoryBatch | undefined;
  let preRecoverySettings: WebSettings | undefined;
  let cameraRoundToken = 0;
  let runtime: WebWorkbenchRuntime | undefined;
  let runtimeInitialized = false;
  let processingWorkspace: ProcessingBatchWorkspace | undefined;
  let runtimeDecisions: Partial<Record<'queue' | 'camera', ProcessingRuntimeDecision>> = {};
  let current: WebWorkbenchSnapshot = {
    phase: 'empty',
    primaryAction: {
      kind: 'pick-images',
      availability: { status: 'available' },
    },
    processing: {
      status: 'idle',
      canStop: false,
      canCancelCurrent: false,
      canRetryTasks: false,
    },
    runtime: {
      status: 'checking',
      environment: { online: true, visibility: 'visible' },
      modelConsent: false,
      modelPackage: { status: 'checking', storedBytes: 0, totalBytes: 0 },
      modelProbe: { status: 'pending' },
      storage: { status: 'checking' },
      queue: { status: 'blocked', reason: 'CAPABILITY_CHECKING' },
      camera: { status: 'blocked', reason: 'CAPABILITY_CHECKING' },
    },
    provider: {
      configuration: { status: 'blocked', reason: 'CREDENTIAL_MISSING' },
    },
    controls: {
      importImages: { status: 'available' },
      editProcessingSettings: { status: 'available' },
      openCamera: { status: 'blocked', reason: 'CAPABILITY_CHECKING' },
      exitRecovery: { status: 'blocked', reason: 'NO_RECOVERY' },
    },
    settings: structuredClone(initialSettings),
    images: [],
    selectedImageId: null,
    jobs: {},
    itemActions: {},
    importing: false,
    rejections: [],
    draftProviderSelectionRequired: false,
    notice: '',
    history: {
      status: 'loading',
      entries: [],
      busy: false,
      cleanup: { faultCount: 0, unreleasedBytes: 0 },
    },
    diagnostics: { exporting: false },
    camera: {
      open: false,
      round: { status: 'ready' },
      entry: {
        kind: 'unavailable',
        availability: { status: 'blocked', reason: 'CAPABILITY_CHECKING' },
      },
    },
  };

  const projectRuntimeDecisions = (
    snapshot: WebWorkbenchSnapshot,
    credential: ProcessingRuntimeCredentialStatus,
  ): Partial<Record<'queue' | 'camera', ProcessingRuntimeDecision>> => {
    if (!runtime) return runtimeDecisions;
    return {
      queue: runtime.processingRuntime.assess({
        settings: snapshot.settings,
        credential,
        pendingOriginalBytes: snapshot.images.reduce(
          (sum, image) => sum + image.file.size,
          0,
        ),
      }),
      camera: runtime.processingRuntime.assess({
        settings: snapshot.settings,
        credential,
        pendingOriginalBytes: 0,
      }),
    };
  };

  const publish = (patch: Partial<WebWorkbenchSnapshot>): void => {
    if (disposed) return;
    const next = { ...current, ...patch };
    const credential = credentials.status(next.settings);
    runtimeDecisions = projectRuntimeDecisions(next, credential);
    current = projectWebWorkbench({
      snapshot: next,
      runtime: runtime?.processingRuntime.snapshot(),
      decisions: runtimeDecisions,
      batch: activeBatch?.snapshot(),
      credential,
    });
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
    publish({ jobs, notice });

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
    publish({ history: projectWebWorkbenchHistory(runtime.lifecycle.snapshot()) });
    unsubscribeHistory = runtime.lifecycle.subscribe(() => {
      const history = runtime?.lifecycle.snapshot();
      if (history) publish({ history: projectWebWorkbenchHistory(history) });
    });
    unsubscribeProcessingRuntime = runtime.processingRuntime.subscribe(() => {
      publish({});
    });
    unsubscribeCredentials = credentials.subscribe(() => publish({}));
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
    const credential = credentials.resolve(current.settings);
    if (!credential) {
      throw new Error('Provider credential is unavailable');
    }
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
        if (!recoveryBatch) {
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
      publish({ notice: messageFor(error) });
      throw error;
    }
  };

  const runBatchCommand = async (command: ProcessingBatchCommand): Promise<void> => {
    if (!activeBatch) return;
    await activeBatch.dispatch(command);
    if (command.type !== 'detach') return;
    unsubscribeBatch?.();
    unsubscribeBatch = undefined;
    activeBatch = undefined;
    activeBatchToken += 1;
    recoveryBatch = undefined;
    publish({
      phase: current.images.length > 0 ? 'draft' : 'empty',
      notice: '',
    });
  };

  const applyIntent = async (
    intent: WebWorkbenchIntent,
    expectedPrimaryAction?: WebWorkbenchPrimaryAction,
    expectedCameraEntry?: WebWorkbenchCameraEntryAction,
  ): Promise<WebWorkbenchDispatchResult> => {
    if (isHistoryAction(intent)) {
      const outcome = await runtime!.lifecycle.request(historyIntentFor(intent));
      publish({
        historyAction: outcome.status === 'rejected' || outcome.status === 'failed'
          ? outcome
          : undefined,
      });
      if (outcome.status === 'succeeded' && outcome.type === 'project-imported') {
        void runtime!.processingRuntime.dispatch({ type: 'refresh-storage' }).catch((error) => {
          publish({ notice: messageFor(error) });
        });
      }
      if (outcome.status !== 'succeeded') return undefined;
      if (outcome.type === 'artifact-ready') {
        return {
          status: 'effect',
          effect: 'download-history-artifact',
          artifact: outcome.artifact,
        };
      }
      if (outcome.type === 'recovery-prepared' || outcome.type === 'draft-prepared') {
        return {
          status: 'effect',
          effect: 'open-workbench',
          providerSelectionRequired: outcome.type === 'draft-prepared'
            && outcome.providerSelectionRequired,
        };
      }
      return undefined;
    }
    if (intent.type === 'activate-primary') {
      if (
        !expectedPrimaryAction
        || expectedPrimaryAction.availability.status === 'blocked'
        || current.primaryAction !== expectedPrimaryAction
      ) return undefined;
      switch (expectedPrimaryAction.kind) {
        case 'pick-images':
          return { status: 'effect', effect: 'pick-images' };
        case 'open-storage-settings':
          return { status: 'effect', effect: 'open-storage-settings' };
        case 'open-provider-settings':
          return { status: 'effect', effect: 'open-provider-settings' };
        case 'start-processing':
          await startProcessing();
          return undefined;
        case 'stop-processing':
          await runBatchCommand({ type: 'stop' });
          publish({ notice: getCopy(current.settings.uiLocale).batchStopped });
          return undefined;
        case 'install-models':
          await runtime!.processingRuntime.dispatch({ type: 'accept-model-download' });
          return undefined;
        case 'retry-runtime':
          await runtime!.processingRuntime.dispatch({ type: 'retry' });
          return undefined;
      }
    }
    if (intent.type === 'activate-camera-entry') {
      if (
        !expectedCameraEntry
        || expectedCameraEntry.availability.status === 'blocked'
        || current.camera.entry !== expectedCameraEntry
      ) return undefined;
      if (expectedCameraEntry.kind === 'open-storage-settings') {
        return { status: 'effect', effect: 'open-storage-settings' };
      }
      if (expectedCameraEntry.kind === 'open-provider-settings') {
        return { status: 'effect', effect: 'open-provider-settings' };
      }
      if (expectedCameraEntry.kind !== 'open-camera') return undefined;
      if (current.phase !== 'empty') return undefined;
      await startProcessing('continuous-camera');
      resetCameraRound();
      publish({ camera: { ...current.camera, open: true, round: { status: 'ready' } } });
      return undefined;
    }
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
      await startProcessing();
      return undefined;
    }
    if (intent.type === 'stop-processing') {
      if (!activeBatch || activeBatch.snapshot().status !== 'running') return undefined;
      await runBatchCommand({ type: 'stop' });
      publish({ notice: getCopy(current.settings.uiLocale).batchStopped });
      return undefined;
    }
    if (intent.type === 'resume-processing') {
      await runBatchCommand({ type: 'resume' });
      publish({ notice: '' });
      return undefined;
    }
    if (intent.type === 'detach-processing') {
      await runBatchCommand({ type: 'detach' });
      return undefined;
    }
    if (intent.type === 'cancel-current') {
      if (!activeBatch?.snapshot().currentTaskId) return undefined;
      await runBatchCommand({ type: 'cancel-current' });
      return undefined;
    }
    if (intent.type === 'retry-task') {
      if (!activeBatch) return undefined;
      await runBatchCommand({ type: 'retry', taskId: intent.taskId });
      publish({ notice: '' });
      return undefined;
    }
    if (
      intent.type === 'refresh-runtime'
      || intent.type === 'refresh-storage'
      || intent.type === 'install-models'
      || intent.type === 'cancel-model-install'
      || intent.type === 'retry-runtime'
    ) {
      if (!runtime) throw new Error('Processing runtime is unavailable');
      const command: WebWorkbenchRuntimeCommand = intent.type === 'refresh-runtime'
        ? { type: 'refresh' }
        : intent.type === 'refresh-storage'
          ? { type: 'refresh-storage' }
          : intent.type === 'install-models'
            ? { type: 'accept-model-download' }
            : intent.type === 'cancel-model-install'
              ? { type: 'cancel-model-download' }
              : { type: 'retry' };
      await runtime.processingRuntime.dispatch(command);
      return undefined;
    }
    if (intent.type === 'export-diagnostics') {
      if (!diagnostics) throw new Error('Diagnostic export is unavailable');
      const credential = credentials.status(current.settings);
      const providerBlocked = current.runtime.queue.status === 'blocked'
        && (
          current.runtime.queue.reason === 'PROVIDER_INVALID'
          || current.runtime.queue.reason === 'CREDENTIAL_MISSING'
          || current.runtime.queue.reason === 'CREDENTIAL_TARGET_MISMATCH'
        );
      publish({ diagnostics: { exporting: true } });
      try {
        await diagnostics.export({
          settings: structuredClone(current.settings),
          runtime: {
            capability: current.runtime.capability,
            modelPackage: current.runtime.modelPackage,
          },
          jobs: Object.values(current.jobs).map((job) => ({
            status: job.status,
            progress: job.progress ? { stage: job.progress.stage } : undefined,
            errorCode: job.errorCode,
          })),
          providerConfigurationValid: current.settings.processMode !== 'translate'
            || (credential.available && !providerBlocked),
        });
      } finally {
        publish({ diagnostics: { exporting: false } });
      }
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
          ...current.camera,
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
              ...current.camera,
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
                      ...current.camera,
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
              ...current.camera,
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
                ...current.camera,
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
      publish({
        camera: { ...current.camera, open: false, round: { status: 'ready' } },
      });
      if (batch?.snapshot().kind === 'continuous-camera') {
        if (batch.snapshot().input === 'open') {
          await batch.dispatch({ type: 'close-input' });
        }
        if (activeBatch === batch && batch.snapshot().status === 'paused') {
          await runBatchCommand({ type: 'detach' });
        }
      }
      return undefined;
    }
    if (intent.type === 'exit-recovery') {
      if (activeBatch?.snapshot().status === 'paused') {
        await runBatchCommand({ type: 'detach' });
        return undefined;
      }
      if (recoveryBatch) {
        const outcome = await runtime?.lifecycle.request({
          type: 'discard-recovery',
          batchId: recoveryBatch.id,
        });
        publish({
          historyAction: outcome?.status === 'rejected' || outcome?.status === 'failed'
            ? outcome
            : undefined,
        });
      }
      return undefined;
    }
    if (intent.type === 'visibility-hidden') {
      if (activeBatch?.snapshot().status === 'running') {
        await runBatchCommand({ type: 'stop' });
      }
      return undefined;
    }
    if (intent.type === 'clear-rejections') {
      publish({ rejections: [] });
      return undefined;
    }
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
      if (intent.type === 'cancel-model-install') {
        return runtime!.processingRuntime.dispatch({ type: 'cancel-model-download' })
          .then(() => undefined)
          .catch((error) => {
            publish({ notice: messageFor(error) });
            throw error;
          });
      }
      const expectedPrimaryAction = intent.type === 'activate-primary'
        ? current.primaryAction
        : undefined;
      const expectedCameraEntry = intent.type === 'activate-camera-entry'
        ? current.camera.entry
        : undefined;
      const operation = commandTail
        .then(() => applyIntent(intent, expectedPrimaryAction, expectedCameraEntry))
        .catch((error) => {
          publish({ notice: messageFor(error) });
          throw error;
        });
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
      unsubscribeCredentials?.();
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
