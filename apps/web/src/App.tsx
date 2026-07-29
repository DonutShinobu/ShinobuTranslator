import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  WEB_SETTINGS_STORAGE_KEY,
  createWebSettingsDraftFromLockedConfig,
  decodeWebSettings,
  defaultWebProviderProfiles,
  encodeWebSettings,
  normalizeProviderTargetBinding,
  restoreWebSettingsFromLockedConfig,
  translationProviderOptions,
  validateProviderBaseUrl,
  type ProcessMode,
  type TargetLanguage,
  type TranslationProviderId,
  type UiLocale,
  type WebSettings,
} from '@shinobu/shared-config';
import brandIconUrl from '../../../public/icons/icon128.png';
import brandWordmarkUrl from '../../../public/brand/shinobu-wordmark.svg';
import { Icon, type IconName } from './icons';
import { describeImportRejection, getCopy } from './i18n';
import { HistoryView } from './features/history/HistoryView';
import { SettingsView } from './features/settings/SettingsView';
import {
  ContinuousCamera,
  type ContinuousCameraRoundState,
} from './features/camera/ContinuousCamera';
import type {
  LocalHistoryBatch,
} from './features/history/localHistory';
import type {
  HistoryIntent,
  HistoryOutcome,
  HistoryRejectionCode,
  LocalHistoryWorkbenchAdapter,
} from './features/history/localHistoryLifecycle';
import {
  createRedactedDiagnostics,
  downloadRedactedDiagnostics,
} from './features/diagnostics/redactedDiagnostics';
import { useLocalHistoryLifecycle } from './features/history/useLocalHistoryLifecycle';
import { decodeBrowserImage } from './features/import/browserImageDecoder';
import {
  createImageImporter,
  imageImportLimitsForDevice,
  type ImageImportRejection,
  type ImportedImage,
} from './features/import/imageImporter';
import { useProviderSecrets } from './features/providers/useProviderSecrets';
import {
  createProcessingBatchWorkspace,
  type ProcessingBatch,
  type ProcessingTaskSnapshot,
} from './features/processing/processingBatch';
import {
  bindProcessingBatchHost,
  type QueueJobState,
  type QueueJobStatus,
} from './features/processing/processingBatchHost';
import type { ProcessingRuntimeDecision } from './features/processing/processingRuntime';
import { useProcessingRuntime } from './features/processing/useProcessingRuntime';
import {
  IMAGE_IMPORT_STORAGE_HEADROOM_BYTES,
  assessImageImportStorage,
  formatByteSize as formatBytes,
  type WebStorageSnapshot,
} from './features/storage/storageBudget';
import { usePwaLifecycle } from './pwa/usePwaLifecycle';
import { usePwaInstall } from './pwa/usePwaInstall';
import { WEB_MODEL_PACKAGE } from './runtime/modelPackage';
import { detectWebDeviceProfile } from './runtime/deviceProfile';

type MobilePane = 'queue' | 'preview' | 'settings';
type PreviewMode = 'original' | 'result';
type PreviewScale = 'fit' | number;
type ActiveView = 'workbench' | 'history' | 'settings';
const processModes: ReadonlyArray<ProcessMode> = ['translate', 'original', 'erase'];
const previewZoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LOCAL_HISTORY_VERSIONS = {
  app: '0.1.0',
  core: '0.8.1',
  model: WEB_MODEL_PACKAGE.version,
  configSchema: 1,
} as const;

function readInitialSettings(): WebSettings {
  let serialized: string | null = null;
  try {
    serialized = localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or constrained contexts.
  }
  return decodeWebSettings(serialized, navigator.language).settings;
}

function historyRejectionMessage(
  code: HistoryRejectionCode,
  locale: UiLocale,
): string {
  const traditional = locale === 'zh-TW';
  const messages: Record<HistoryRejectionCode, [string, string]> = {
    'workbench-occupied': ['当前工作台已有草稿或活动批次', '目前工作台已有草稿或活動批次'],
    'batch-occupied': ['此处理批次正在另一个工作台中使用', '此處理批次正在另一個工作台中使用'],
    'partial-history': ['此本地历史部分损坏，无法执行该操作', '此本機歷史部分損壞，無法執行該操作'],
    'results-only': ['此记录只保留结果，不能恢复或克隆', '此記錄只保留結果，不能恢復或複製'],
    'no-results': ['此处理批次没有可导出的结果', '此處理批次沒有可匯出的結果'],
    'nothing-to-resume': ['此处理批次没有等待恢复的图片任务', '此處理批次沒有等待恢復的圖片任務'],
    'provider-unavailable': ['原处理批次的供应商当前不可用', '原處理批次的供應商目前不可用'],
    'result-unavailable': ['结果文件缺失或损坏', '結果檔案遺失或損壞'],
    'recovery-not-prepared': ['处理批次恢复准备已失效', '處理批次恢復準備已失效'],
    'pending-operation': ['已有一项等待撤销的历史操作', '已有一項等待復原的歷史操作'],
    'coordination-unavailable': ['当前浏览器无法安全协调多个工作台', '目前瀏覽器無法安全協調多個工作台'],
    'batch-not-found': ['找不到本地历史批次', '找不到本機歷史批次'],
  };
  return messages[code][traditional ? 1 : 0];
}

export function App() {
  const [settings, setSettings] = useState<WebSettings>(readInitialSettings);
  const [activeView, setActiveView] = useState<ActiveView>('workbench');
  const [queue, setQueue] = useState<ImportedImage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejections, setRejections] = useState<ImageImportRejection[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('preview');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('original');
  const [previewScale, setPreviewScale] = useState<PreviewScale>('fit');
  const [jobs, setJobs] = useState<Record<string, QueueJobState>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchNotice, setBatchNotice] = useState('');
  const [historyActionError, setHistoryActionError] = useState<string>();
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [storageImportError, setStorageImportError] = useState<string>();
  const [resumeHistoryBatchId, setResumeHistoryBatchId] = useState<string>();
  const [draftProviderSelectionRequired, setDraftProviderSelectionRequired] = useState(false);
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(false);
  const [continuousCameraOpen, setContinuousCameraOpen] = useState(false);
  const [continuousCameraRound, setContinuousCameraRound] =
    useState<ContinuousCameraRoundState>({ status: 'ready' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const queueRef = useRef(queue);
  const jobsRef = useRef(jobs);
  const batchRunningRef = useRef(batchRunning);
  const activeProcessingBatchRef = useRef<ProcessingBatch | null>(null);
  const processingBatchUnsubscribeRef = useRef<(() => void) | null>(null);
  const resumeHistoryBatchRef = useRef<LocalHistoryBatch | null>(null);
  const preRecoverySettingsRef = useRef<WebSettings | null>(null);
  const historyWorkbenchAdapterRef = useRef<LocalHistoryWorkbenchAdapter | null>(null);
  const activeImportPromiseRef = useRef<Promise<void> | null>(null);
  const continuousCameraRoundIdRef = useRef(0);
  const continuousCameraCaptureActiveRef = useRef(false);
  const continuousCameraUrlsRef = useRef<Set<string>>(new Set());
  const {
    runtime: processingRuntime,
    snapshot: processingRuntimeSnapshot,
  } = useProcessingRuntime();
  const providerSecrets = useProviderSecrets(settings.providerProfiles);
  const historyWorkbench = useMemo<LocalHistoryWorkbenchAdapter>(() => ({
    occupied: () => historyWorkbenchAdapterRef.current?.occupied() ?? true,
    installRecovery: (preparation) => {
      const adapter = historyWorkbenchAdapterRef.current;
      if (!adapter) throw new Error('History workbench adapter is unavailable');
      return adapter.installRecovery(preparation);
    },
    installDraft: (preparation) => {
      const adapter = historyWorkbenchAdapterRef.current;
      if (!adapter) throw new Error('History workbench adapter is unavailable');
      return adapter.installDraft(preparation);
    },
    discardRecovery: (batchId) => {
      historyWorkbenchAdapterRef.current?.discardRecovery(batchId);
    },
  }), []);
  const localHistory = useLocalHistoryLifecycle(historyWorkbench);
  const pwa = usePwaLifecycle();
  const pwaInstall = usePwaInstall();

  const copy = getCopy(settings.uiLocale);
  const historySnapshot = localHistory.snapshot;
  const historyCleanupFaultMessage = historySnapshot.faults.length > 0
    ? settings.uiLocale === 'zh-TW'
      ? `${historySnapshot.faults.length} 項本機資源仍待清理，尚未釋放 `
        + `${formatBytes(historySnapshot.faults.reduce(
          (total, fault) => total + fault.unreleasedBytes,
          0,
        ))}`
      : `${historySnapshot.faults.length} 项本地资源仍待清理，尚未释放 `
        + `${formatBytes(historySnapshot.faults.reduce(
          (total, fault) => total + fault.unreleasedBytes,
          0,
        ))}`
    : undefined;
  const capability = processingRuntimeSnapshot.capability ?? null;
  const modelPackageState = processingRuntimeSnapshot.modelPackage;
  const modelRuntimeProbe = processingRuntimeSnapshot.modelProbe;
  const modelConsent = processingRuntimeSnapshot.modelConsent;
  const storageChecking = processingRuntimeSnapshot.storage.status === 'checking';
  const storageSnapshot: WebStorageSnapshot | null =
    processingRuntimeSnapshot.storage.status === 'checking'
    ? null
    : processingRuntimeSnapshot.storage;
  const deviceProfile = useMemo(() => detectWebDeviceProfile(), []);
  const imageImportLimits = useMemo(
    () => imageImportLimitsForDevice(
      deviceProfile.mobile,
      capability?.workPixelBudget ?? deviceProfile.initialWorkPixelBudget,
    ),
    [capability?.workPixelBudget, deviceProfile],
  );
  const importer = useMemo(
    () => createImageImporter({
      decodeImage: decodeBrowserImage,
      limits: imageImportLimits,
    }),
    [imageImportLimits],
  );
  const invalidateChangedLockedProvider = (nextSettings: WebSettings): void => {
    const providerId = nextSettings.translationProviderId;
    let changed = true;
    try {
      changed = normalizeProviderTargetBinding(
        nextSettings.providerProfiles[providerId].baseUrl,
      ) !== normalizeProviderTargetBinding(
        settings.providerProfiles[providerId].baseUrl,
      );
    } catch {
      // Invalid legacy targets must never retain a current provider secret.
    }
    if (changed) providerSecrets.invalidateTarget(providerId);
  };
  const clearWorkbenchFiles = (): void => {
    queueRef.current.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
    Object.values(jobsRef.current).forEach((job) => {
      if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
    });
  };
  historyWorkbenchAdapterRef.current = {
    occupied: () => Boolean(
      activeProcessingBatchRef.current
      || resumeHistoryBatchRef.current
      || queueRef.current.length > 0
    ),
    async installRecovery(preparation) {
      const orderedItems = [...preparation.batch.items]
        .sort((left, right) => left.order - right.order);
      const imported = await importer.importFiles(preparation.files, []);
      if (imported.accepted.length !== orderedItems.length) {
        imported.accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
        throw new Error('历史原图未能全部通过当前版本的导入校验');
      }
      const nextSettings = restoreWebSettingsFromLockedConfig(
        preparation.batch.lockedConfig,
        settings,
      );
      if (!nextSettings) {
        imported.accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
        throw new Error('原处理批次的供应商当前不可用');
      }
      const restoredImages = imported.accepted.map((image, index) => ({
        ...image,
        id: orderedItems[index].id,
      }));
      const restoredJobs: Record<string, QueueJobState> = {};
      for (const item of orderedItems) {
        restoredJobs[item.id] = item.status === 'done'
          ? {
              status: 'done',
              progress: { stage: 'done', detail: '已从恢复点载入' },
            }
          : {
              status: item.status === 'running' ? 'queued' : item.status,
              error: item.error,
            };
      }

      invalidateChangedLockedProvider(nextSettings);
      clearWorkbenchFiles();
      preRecoverySettingsRef.current = structuredClone(settings);
      queueRef.current = restoredImages;
      jobsRef.current = restoredJobs;
      setQueue(restoredImages);
      setJobs(restoredJobs);
      setSelectedId(
        orderedItems.find((item) => item.status !== 'done')?.id
        ?? orderedItems[0]?.id
        ?? null,
      );
      setPreviewMode('original');
      setSettings(nextSettings);
      resumeHistoryBatchRef.current = preparation.batch;
      setResumeHistoryBatchId(preparation.batch.id);
      setDraftProviderSelectionRequired(false);
      setRejections([]);
      setBatchNotice(copy.historyResumeReady);
      setHistoryActionError(undefined);
      setActiveView('workbench');
    },
    async installDraft(preparation) {
      const imported = await importer.importFiles(preparation.files, []);
      if (imported.accepted.length !== preparation.files.length) {
        imported.accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
        throw new Error('历史原图未能全部通过当前版本的导入校验');
      }
      const draft = createWebSettingsDraftFromLockedConfig(
        preparation.sourceBatch.lockedConfig,
        settings,
      );
      if (!draft.providerSelectionRequired) invalidateChangedLockedProvider(draft.settings);
      clearWorkbenchFiles();
      preRecoverySettingsRef.current = null;
      queueRef.current = imported.accepted;
      jobsRef.current = {};
      setQueue(imported.accepted);
      setJobs({});
      setSelectedId(imported.accepted[0]?.id ?? null);
      setPreviewMode('original');
      setSettings(draft.settings);
      resumeHistoryBatchRef.current = null;
      setResumeHistoryBatchId(undefined);
      setDraftProviderSelectionRequired(draft.providerSelectionRequired);
      setProviderDetailsOpen(draft.providerSelectionRequired);
      setRejections([]);
      setBatchNotice(
        draft.providerSelectionRequired
          ? '原供应商已不可用，请选择当前可用的供应商后再开始。'
          : '',
      );
      setHistoryActionError(undefined);
      setActiveView('workbench');
    },
    discardRecovery(batchId) {
      if (resumeHistoryBatchRef.current?.id !== batchId) return;
      clearWorkbenchFiles();
      queueRef.current = [];
      jobsRef.current = {};
      setQueue([]);
      setJobs({});
      setSelectedId(null);
      setPreviewMode('original');
      if (preRecoverySettingsRef.current) {
        setSettings(preRecoverySettingsRef.current);
      }
      preRecoverySettingsRef.current = null;
      resumeHistoryBatchRef.current = null;
      setResumeHistoryBatchId(undefined);
      setDraftProviderSelectionRequired(false);
      setRejections([]);
      setBatchNotice('');
    },
  };
  const selectedImage = queue.find((image) => image.id === selectedId) ?? null;
  const selectedJob = selectedId ? jobs[selectedId] : undefined;
  const activeProviderProfile = settings.providerProfiles[settings.translationProviderId];
  const activeProviderSecret = providerSecrets.entries[settings.translationProviderId];
  const activeProviderKey = activeProviderSecret.value;
  const providerConfigurationError = validateProviderBaseUrl(activeProviderProfile.baseUrl)
    || (!activeProviderProfile.model.trim() ? `${copy.model}不能为空` : null)
    || (!activeProviderKey.trim() ? `${copy.apiKey}不能为空` : null);
  const providerValidationError = settings.processMode === 'translate'
    ? providerConfigurationError
    : null;
  const providerReady = providerValidationError === null;
  const totalBytes = queue.reduce((sum, image) => sum + image.file.size, 0);
  const processingCredential = {
    providerId: settings.translationProviderId,
    target: activeProviderProfile.baseUrl,
    value: activeProviderKey,
  };
  const queueRuntimeDecision = processingRuntime.assess({
    settings,
    credential: processingCredential,
    pendingOriginalBytes: totalBytes,
  });
  const cameraRuntimeDecision = processingRuntime.assess({
    settings,
    credential: processingCredential,
    pendingOriginalBytes: 0,
  });
  const runtimeBlockerMessage = (
    decision: ProcessingRuntimeDecision,
  ): string => {
    if (decision.status === 'ready') return '';
    switch (decision.code) {
      case 'OFFLINE':
        return copy.offlineHistoryOnly;
      case 'CAPABILITY_CHECKING':
      case 'MODEL_PACKAGE_CHECKING':
      case 'MODEL_PROBING':
      case 'STORAGE_CHECKING':
        return copy.modelGateChecking;
      case 'MODEL_CONSENT_REQUIRED':
      case 'MODEL_PACKAGE_MISSING':
      case 'MODEL_INSTALLING':
      case 'MODEL_INSTALL_PAUSED':
        return copy.modelGatePending;
      case 'STORAGE_UNAVAILABLE':
        return copy.storageUnavailable;
      case 'INSUFFICIENT_STORAGE':
        return copy.storageImportBlocked(
          formatBytes(decision.requiredBytes ?? 0),
          formatBytes(decision.availableBytes ?? 0),
        );
      default:
        return decision.detail ?? copy.startUnavailable;
    }
  };
  const storageHardBlocked = storageSnapshot?.status === 'unavailable'
    || (
      storageSnapshot?.status === 'ready'
      && storageSnapshot.availableBytes < IMAGE_IMPORT_STORAGE_HEADROOM_BYTES
    );
  const storageImportIssue = storageImportError
    ?? (storageSnapshot?.status === 'unavailable'
      ? copy.storageUnavailable
      : storageSnapshot?.status === 'ready'
        && storageSnapshot.availableBytes < IMAGE_IMPORT_STORAGE_HEADROOM_BYTES
        ? copy.storageLow(formatBytes(storageSnapshot.availableBytes))
        : undefined);

  useEffect(() => {
    if (settings.processMode === 'translate') {
      setProviderDetailsOpen(providerConfigurationError !== null);
    }
  }, [settings.processMode, settings.translationProviderId]);

  useEffect(() => {
    setPreviewScale('fit');
  }, [selectedId]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    batchRunningRef.current = batchRunning;
  }, [batchRunning]);

  const refreshStorage = useCallback(async (): Promise<WebStorageSnapshot> => {
    await processingRuntime.dispatch({ type: 'refresh-storage' });
    const snapshot = processingRuntime.snapshot().storage;
    if (snapshot.status === 'checking') {
      throw new Error('浏览器存储状态仍在检查');
    }
    return snapshot;
  }, [processingRuntime]);
  const processingWorkspace = useMemo(
    () => createProcessingBatchWorkspace({
      history: localHistory.history,
      coordinator: localHistory.coordinator,
      runtime: processingRuntime,
      async readThumbnail(image) {
        try {
          const response = await fetch(image.thumbnailUrl);
          return response.ok ? await response.blob() : undefined;
        } catch {
          return undefined;
        }
      },
    }),
    [localHistory.coordinator, localHistory.history, processingRuntime],
  );

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        const activeBatch = activeProcessingBatchRef.current;
        if (activeBatch?.snapshot().status === 'running') {
          void activeBatch.dispatch({ type: 'stop' }).catch(() => undefined);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => () => {
    continuousCameraRoundIdRef.current += 1;
    queueRef.current.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
    Object.values(jobsRef.current).forEach((job) => {
      if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
    });
    const activeBatch = activeProcessingBatchRef.current;
    if (activeBatch?.snapshot().status === 'running') {
      void activeBatch.dispatch({ type: 'stop' }).catch(() => undefined);
    }
    processingBatchUnsubscribeRef.current?.();
    continuousCameraUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    continuousCameraUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    document.documentElement.lang = settings.uiLocale;
    try {
      localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, encodeWebSettings(settings));
    } catch {
      // The workbench stays usable when preference persistence is unavailable.
    }
  }, [settings]);

  useEffect(() => {
    setPreviewUrl(null);
    if (!selectedImage) return undefined;
    const url = URL.createObjectURL(selectedImage.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedImage]);

  useEffect(() => {
    if (previewMode === 'result' && selectedJob?.status !== 'done') {
      setPreviewMode('original');
    }
  }, [previewMode, selectedJob?.status]);

  const attachProcessingBatch = (
    batch: ProcessingBatch,
    projectQueue: boolean,
  ): void => {
    processingBatchUnsubscribeRef.current?.();
    activeProcessingBatchRef.current = batch;
    setResumeHistoryBatchId(batch.snapshot().id);
    const unsubscribe = bindProcessingBatchHost({
      batch,
      projectQueue,
      historyStorageError: copy.historyStorageError,
      getJobs: () => jobsRef.current,
      replaceJobs(next) {
        jobsRef.current = next;
        setJobs(next);
      },
      setRunning(running) {
        batchRunningRef.current = running;
        setBatchRunning(running);
      },
      hasActiveImport: () => Boolean(activeImportPromiseRef.current),
      setNotice: setBatchNotice,
      onTerminal(snapshot) {
        if (activeProcessingBatchRef.current === batch) {
          activeProcessingBatchRef.current = null;
          setResumeHistoryBatchId(undefined);
        }
        batchRunningRef.current = false;
        setBatchRunning(false);
        void localHistory.lifecycle.request({ type: 'refresh' });
        void refreshStorage();
        if (snapshot.tasks.some((task) => task.status === 'done')) {
          pwaInstall.offerAfterSuccess();
        }
      },
    });
    processingBatchUnsubscribeRef.current = unsubscribe;
  };

  const importFiles = useCallback((files: readonly File[]): Promise<void> => {
    if (files.length === 0 || activeImportPromiseRef.current) return Promise.resolve();
    if (resumeHistoryBatchId && !batchRunningRef.current) {
      setBatchNotice(copy.historyResumeReady);
      return Promise.resolve();
    }
    setImporting(true);
    const operation = (async (): Promise<void> => {
      try {
        const result = await importer.importFiles(files, queueRef.current);
        const activeBatch = activeProcessingBatchRef.current;
        let accepted = result.accepted;
        if (accepted.length > 0) {
          const snapshot = await refreshStorage();
          const pendingOriginalBytes = (
            (activeBatch
              ? 0
              : queueRef.current.reduce((sum, image) => sum + image.file.size, 0))
            + accepted.reduce((sum, image) => sum + image.file.size, 0)
          );
          const storageAssessment = assessImageImportStorage(
            snapshot,
            pendingOriginalBytes,
          );
          if (!storageAssessment.allowed) {
            accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
            const message = storageAssessment.reason === 'unavailable'
              ? copy.storageUnavailable
              : copy.storageImportBlocked(
                  formatBytes(storageAssessment.requiredBytes),
                  formatBytes(storageAssessment.availableBytes ?? 0),
                );
            setStorageImportError(message);
            setBatchNotice(message);
            accepted = [];
          } else {
            setStorageImportError(undefined);
            setBatchNotice('');
          }
        }
        if (accepted.length > 0) {
          if (activeBatch) {
            try {
              await activeBatch.dispatch({ type: 'append', images: accepted });
            } catch (error) {
              accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
              setBatchNotice(
                `${copy.historyStorageError}: ${error instanceof Error ? error.message : String(error)}`,
              );
              return;
            }
          }
          const nextQueue = [...queueRef.current, ...accepted];
          queueRef.current = nextQueue;
          setQueue(nextQueue);
          setSelectedId((current) => current ?? accepted[0].id);
          if (activeBatch) {
            setJobs((current) => {
              const next = { ...current };
              for (const image of accepted) {
                next[image.id] = { status: 'queued' };
              }
              jobsRef.current = next;
              return next;
            });
          }
          setMobilePane('preview');
          void refreshStorage();
        }
        if (result.rejected.length > 0) {
          setRejections((current) => [...current, ...result.rejected]);
        }
      } finally {
        setImporting(false);
      }
    })();
    const tracked = operation.finally(() => {
      if (activeImportPromiseRef.current === tracked) {
        activeImportPromiseRef.current = null;
        const activeBatch = activeProcessingBatchRef.current;
        const snapshot = activeBatch?.snapshot();
        if (
          activeBatch
          && snapshot?.kind === 'queue'
          && snapshot.status === 'running'
          && snapshot.input === 'open'
          && !snapshot.tasks.some(
            (task) => task.status === 'queued' || task.status === 'running',
          )
        ) {
          void activeBatch.dispatch({ type: 'close-input' }).catch(() => undefined);
        }
      }
    });
    activeImportPromiseRef.current = tracked;
    return tracked;
  }, [
    copy.historyResumeReady,
    copy.historyStorageError,
    copy.storageImportBlocked,
    copy.storageUnavailable,
    importer,
    localHistory,
    refreshStorage,
    resumeHistoryBatchId,
  ]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void importFiles(files);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [importFiles]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void importFiles(files);
  };

  const patchSettings = (patch: Partial<WebSettings>): void => {
    if (batchRunningRef.current) return;
    if (
      resumeHistoryBatchId
      && Object.keys(patch).some((key) => key !== 'uiLocale')
    ) {
      return;
    }
    if (patch.translationProviderId !== undefined) {
      setDraftProviderSelectionRequired(false);
      setBatchNotice('');
    }
    setSettings((current) => ({ ...current, ...patch }));
  };

  const patchActiveProviderProfile = (
    patch: Partial<WebSettings['providerProfiles'][TranslationProviderId]>,
  ): void => {
    if (batchRunningRef.current || resumeHistoryBatchId) return;
    setDraftProviderSelectionRequired(false);
    setBatchNotice('');
    const providerId = settings.translationProviderId;
    if (patch.baseUrl !== undefined) {
      let targetChanged = patch.baseUrl !== activeProviderProfile.baseUrl;
      try {
        targetChanged = normalizeProviderTargetBinding(patch.baseUrl)
          !== normalizeProviderTargetBinding(activeProviderProfile.baseUrl);
      } catch {
        // An invalid intermediate edit is a different target and must drop the key.
      }
      if (targetChanged) {
        providerSecrets.invalidateTarget(providerId);
      }
    }
    setSettings((current) => ({
      ...current,
      providerProfiles: {
        ...current.providerProfiles,
        [providerId]: {
          ...current.providerProfiles[providerId],
          ...patch,
        },
      },
    }));
  };

  const updateProviderKey = (value: string): void => {
    providerSecrets.update(settings.translationProviderId, value);
  };

  const removeActiveProviderConfiguration = async (): Promise<void> => {
    if (batchRunningRef.current || resumeHistoryBatchId) return;
    const providerId = settings.translationProviderId;
    await providerSecrets.clear(providerId);
    setSettings((current) => ({
      ...current,
      providerProfiles: {
        ...current.providerProfiles,
        [providerId]: structuredClone(defaultWebProviderProfiles[providerId]),
      },
    }));
  };

  const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleHistoryOutcome = async (intent: HistoryIntent): Promise<HistoryOutcome> => {
    const outcome = await localHistory.lifecycle.request(intent);
    if (outcome.status === 'rejected') {
      setHistoryActionError(historyRejectionMessage(outcome.code, settings.uiLocale));
      return outcome;
    }
    if (outcome.status === 'failed') {
      setHistoryActionError(`${outcome.operation}: ${outcome.cause}`);
      return outcome;
    }
    if (outcome.type === 'artifact-ready') {
      if (
        outcome.artifact.kind === 'results'
        && outcome.artifact.omissions.length > 0
        && !window.confirm(
          `有 ${outcome.artifact.omissions.length} 个结果缺失或损坏，将只导出其余 `
          + `${outcome.artifact.exportedCount} 个结果。是否继续？`,
        )
      ) {
        return outcome;
      }
      downloadBlob(outcome.artifact.blob, outcome.artifact.fileName);
    }
    if (outcome.type === 'project-imported') void refreshStorage();
    setHistoryActionError(undefined);
    return outcome;
  };

  const exportHistoryProject = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyExportWarning)) return;
    await handleHistoryOutcome({ type: 'export-project', batchId });
  };

  const keepHistoryResultsOnly = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyKeepResultsWarning)) return;
    await handleHistoryOutcome({ type: 'stage-keep-results-only', batchId });
  };

  const removeImage = async (id: string): Promise<void> => {
    if (importing || activeImportPromiseRef.current) return;
    const job = jobsRef.current[id];
    if (job?.status === 'running') return;
    const currentQueue = queueRef.current;
    const index = currentQueue.findIndex((image) => image.id === id);
    if (index < 0) return;
    const activeBatch = activeProcessingBatchRef.current;
    if (resumeHistoryBatchId && !activeBatch) return;
    if (activeBatch) {
      if (job?.status !== 'queued') return;
      try {
        await activeBatch.dispatch({ type: 'remove-queued', taskId: id });
      } catch (error) {
        setBatchNotice(
          `${copy.historyStorageError}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    URL.revokeObjectURL(currentQueue[index].thumbnailUrl);
    if (job?.resultUrl) URL.revokeObjectURL(job.resultUrl);
    const next = currentQueue.filter((image) => image.id !== id);
    queueRef.current = next;
    setQueue(next);
    setJobs((current) => {
      const nextJobs = { ...current };
      delete nextJobs[id];
      jobsRef.current = nextJobs;
      return nextJobs;
    });
    if (selectedId === id) {
      setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
  };

  const moveImage = async (id: string, direction: -1 | 1): Promise<void> => {
    if (importing || activeImportPromiseRef.current) return;
    const current = queueRef.current;
    const index = current.findIndex((image) => image.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    if (
      jobsRef.current[id]?.status === 'running'
      || jobsRef.current[current[target].id]?.status === 'running'
    ) {
      return;
    }
    const activeBatch = activeProcessingBatchRef.current;
    if (resumeHistoryBatchId && !activeBatch) return;
    if (
      activeBatch
      && (
        jobsRef.current[id]?.status !== 'queued'
        || jobsRef.current[current[target].id]?.status !== 'queued'
      )
    ) {
      return;
    }
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    if (activeBatch) {
      try {
        await activeBatch.dispatch({
          type: 'reorder-queued',
          taskIds: next.map((image) => image.id),
        });
      } catch (error) {
        setBatchNotice(
          `${copy.historyStorageError}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    queueRef.current = next;
    setQueue(next);
  };

  const handleDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const modeLabel = (mode: ProcessMode): string => {
    if (mode === 'translate') return copy.translate;
    if (mode === 'original') return copy.originalReflow;
    return copy.eraseOnly;
  };

  const jobStatusLabel = (status: QueueJobStatus): string => {
    if (status === 'queued') return copy.statusQueued;
    if (status === 'running') return copy.statusRunning;
    if (status === 'done') return copy.statusDone;
    if (status === 'failed') return copy.statusFailed;
    return copy.statusCancelled;
  };

  const acceptModelDownload = (): void => {
    void processingRuntime.dispatch({ type: 'accept-model-download' })
      .catch((error) => {
        setBatchNotice(error instanceof Error ? error.message : String(error));
      });
  };

  const cancelCurrent = (): void => {
    const activeBatch = activeProcessingBatchRef.current;
    if (!activeBatch?.snapshot().currentTaskId) return;
    void activeBatch.dispatch({ type: 'cancel-current' }).catch((error) => {
      setBatchNotice(error instanceof Error ? error.message : String(error));
    });
  };

  const stopBatch = (): void => {
    const activeBatch = activeProcessingBatchRef.current;
    if (activeBatch?.snapshot().status !== 'running') return;
    void activeBatch.dispatch({ type: 'stop' })
      .then(() => setBatchNotice(copy.batchStopped))
      .catch((error) => {
        setBatchNotice(error instanceof Error ? error.message : String(error));
      });
  };

  const retryTask = (taskId: string): void => {
    const activeBatch = activeProcessingBatchRef.current;
    if (!activeBatch) return;
    void activeBatch.dispatch({ type: 'retry', taskId })
      .then(() => setBatchNotice(''))
      .catch((error) => {
        setBatchNotice(error instanceof Error ? error.message : String(error));
      });
  };

  const exitHistoryResume = (): void => {
    if (batchRunningRef.current) return;
    const activeBatch = activeProcessingBatchRef.current;
    if (activeBatch?.snapshot().status === 'paused') {
      void activeBatch.dispatch({ type: 'detach' })
        .then(() => {
          if (activeProcessingBatchRef.current === activeBatch) {
            activeProcessingBatchRef.current = null;
          }
          resumeHistoryBatchRef.current = null;
          setResumeHistoryBatchId(undefined);
          setBatchNotice('');
        })
        .catch((error) => {
          setBatchNotice(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    if (resumeHistoryBatchId) {
      void handleHistoryOutcome({
        type: 'discard-recovery',
        batchId: resumeHistoryBatchId,
      });
    }
  };

  const startBatch = async (): Promise<void> => {
    const existingBatch = activeProcessingBatchRef.current;
    if (existingBatch) {
      const snapshot = existingBatch.snapshot();
      if (snapshot.status === 'paused' && snapshot.persistence.status === 'healthy') {
        try {
          await existingBatch.dispatch({ type: 'resume' });
          setBatchNotice('');
        } catch (error) {
          setBatchNotice(error instanceof Error ? error.message : String(error));
        }
      } else if (snapshot.persistence.status === 'faulted') {
        setBatchNotice(
          `${copy.historyStorageError}: ${snapshot.persistence.error}`,
        );
      }
      return;
    }
    if (
      activeImportPromiseRef.current
      || queueRef.current.length === 0
      || queueRuntimeDecision.status !== 'ready'
    ) {
      return;
    }

    setBatchNotice('');
    const resumedBatchId = resumeHistoryBatchId;

    const nextJobs: Record<string, QueueJobState> = {};
    for (const image of queueRef.current) {
      const previous = jobsRef.current[image.id];
      if (
        resumedBatchId
        && previous
        && (
          previous.status === 'done'
          || previous.status === 'failed'
          || previous.status === 'cancelled'
        )
      ) {
        nextJobs[image.id] = previous;
      } else {
        if (previous?.resultUrl) URL.revokeObjectURL(previous.resultUrl);
        nextJobs[image.id] = { status: 'queued' };
      }
    }
    jobsRef.current = nextJobs;
    setJobs(nextJobs);

    try {
      let processingBatch: ProcessingBatch;
      if (resumedBatchId) {
        const source = resumeHistoryBatchRef.current;
        if (!source || source.id !== resumedBatchId) {
          throw new Error('恢复处理批次的本地历史上下文已失效');
        }
        processingBatch = await processingWorkspace.resume({
          batch: source,
          images: queueRef.current,
          settings,
          inputLifetime: 'until-closed',
          credential: processingCredential,
        });
        await localHistory.lifecycle.request({
          type: 'handoff-recovery',
          batchId: resumedBatchId,
        });
        resumeHistoryBatchRef.current = null;
        preRecoverySettingsRef.current = null;
      } else {
        processingBatch = await processingWorkspace.open({
          kind: 'queue',
          inputLifetime: 'until-closed',
          initialImages: queueRef.current,
          settings,
          versions: LOCAL_HISTORY_VERSIONS,
          credential: processingCredential,
        });
        setDraftProviderSelectionRequired(false);
      }
      attachProcessingBatch(processingBatch, true);
    } catch (error) {
      batchRunningRef.current = false;
      setBatchRunning(false);
      setBatchNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const exportRedactedDiagnostics = async (): Promise<void> => {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true);
    try {
      const storage = await navigator.storage?.estimate?.().catch(() => undefined);
      const diagnostics = createRedactedDiagnostics({
        locale: settings.uiLocale,
        userAgent: navigator.userAgent,
        versions: LOCAL_HISTORY_VERSIONS,
        device: deviceProfile,
        capability,
        modelPackage: modelPackageState,
        jobs: Object.values(jobs),
        provider: {
          id: settings.translationProviderId,
          baseUrl: activeProviderProfile.baseUrl,
          configurationValid: providerConfigurationError === null,
        },
        lifecycle: {
          online: pwa.online,
          offlineReady: pwa.offlineReady,
          updateReady: pwa.updateReady,
          visibilityState: document.visibilityState,
        },
        storage,
      });
      downloadRedactedDiagnostics(
        diagnostics,
        `shinobu-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      );
    } finally {
      setDiagnosticBusy(false);
    }
  };

  const startAllowed = (
    queue.length > 0
    && !importing
    && !draftProviderSelectionRequired
    && queueRuntimeDecision.status === 'ready'
  );
  const continuousCameraAllowed = (
    !batchRunning
    && !importing
    && !activeImportPromiseRef.current
    && cameraRuntimeDecision.status === 'ready'
    && !resumeHistoryBatchId
  );
  const continuousCameraBlocker = storageImportIssue
    ?? runtimeBlockerMessage(cameraRuntimeDecision);

  const releaseContinuousCameraUrls = (): void => {
    continuousCameraUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    continuousCameraUrlsRef.current.clear();
  };

  const openContinuousCamera = async (): Promise<void> => {
    if (!continuousCameraAllowed) return;
    try {
      const batch = await processingWorkspace.open({
        kind: 'continuous-camera',
        initialImages: [],
        settings,
        versions: LOCAL_HISTORY_VERSIONS,
        credential: processingCredential,
      });
      attachProcessingBatch(batch, false);
      continuousCameraRoundIdRef.current += 1;
      releaseContinuousCameraUrls();
      setContinuousCameraRound({ status: 'ready' });
      setContinuousCameraOpen(true);
    } catch (error) {
      setBatchNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleContinuousCameraEntry = (): void => {
    if (continuousCameraAllowed) {
      void openContinuousCamera();
      return;
    }
    if (storageImportIssue) {
      setActiveView('settings');
      void refreshStorage();
      return;
    }
    if (providerValidationError) setProviderDetailsOpen(true);
    setMobilePane('settings');
  };

  const continueContinuousCamera = (): void => {
    continuousCameraRoundIdRef.current += 1;
    releaseContinuousCameraUrls();
    setContinuousCameraRound({ status: 'ready' });
  };

  const closeContinuousCamera = (): void => {
    continuousCameraRoundIdRef.current += 1;
    const activeBatch = activeProcessingBatchRef.current;
    if (
      activeBatch?.snapshot().kind === 'continuous-camera'
      && activeBatch.snapshot().input === 'open'
    ) {
      void activeBatch.dispatch({ type: 'close-input' })
        .then(async () => {
          if (activeBatch.snapshot().status === 'paused') {
            await activeBatch.dispatch({ type: 'detach' });
            if (activeProcessingBatchRef.current === activeBatch) {
              activeProcessingBatchRef.current = null;
              setResumeHistoryBatchId(undefined);
            }
          }
        })
        .catch((error) => {
          setBatchNotice(error instanceof Error ? error.message : String(error));
        });
    }
    releaseContinuousCameraUrls();
    setContinuousCameraRound({ status: 'ready' });
    setContinuousCameraOpen(false);
  };

  const translateContinuousCameraCapture = async (file: File): Promise<void> => {
    if (
      !continuousCameraOpen
      || continuousCameraCaptureActiveRef.current
    ) {
      return;
    }
    const processingBatch = activeProcessingBatchRef.current;
    if (processingBatch?.snapshot().kind !== 'continuous-camera') return;

    const roundId = continuousCameraRoundIdRef.current + 1;
    continuousCameraRoundIdRef.current = roundId;
    continuousCameraCaptureActiveRef.current = true;
    releaseContinuousCameraUrls();
    const originalUrl = URL.createObjectURL(file);
    continuousCameraUrlsRef.current.add(originalUrl);
    setContinuousCameraRound({
      status: 'preparing',
      originalUrl,
      detail: copy.importing,
    });

    try {
      const imported = await importer.importFiles([file], []);
      if (continuousCameraRoundIdRef.current !== roundId) {
        imported.accepted.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
        return;
      }
      const image = imported.accepted[0];
      if (!image) {
        const rejection = imported.rejected[0];
        throw new Error(rejection
          ? describeImportRejection(settings.uiLocale, rejection.code)
          : copy.cameraCaptureFailed);
      }
      continuousCameraUrlsRef.current.add(image.thumbnailUrl);
      if (continuousCameraRoundIdRef.current !== roundId) {
        throw new DOMException('连续拍摄已关闭', 'AbortError');
      }
      setContinuousCameraRound({
        status: 'translating',
        originalUrl,
        detail: copy.cameraTranslating,
      });
      await processingBatch.dispatch({
        type: 'append',
        images: [image],
      });
      const completedTask = await new Promise<ProcessingTaskSnapshot>((resolve) => {
        let unsubscribe = (): void => undefined;
        unsubscribe = processingBatch.subscribe((snapshot) => {
          const task = snapshot.tasks.find((candidate) => candidate.id === image.id);
          if (!task) return;
          if (
            continuousCameraRoundIdRef.current === roundId
            && task.status === 'running'
          ) {
            setContinuousCameraRound({
              status: 'translating',
              originalUrl,
              detail: task.progress?.detail ?? copy.cameraTranslating,
            });
          }
          if (
            task.status === 'done'
            || task.status === 'failed'
            || task.status === 'cancelled'
          ) {
            queueMicrotask(() => unsubscribe());
            resolve(task);
          }
        });
      });

      if (completedTask.status !== 'done' || !completedTask.result) {
        throw new Error(completedTask.error ?? copy.cameraTranslationFailed);
      }
      const resultUrl = URL.createObjectURL(completedTask.result.image);
      if (continuousCameraRoundIdRef.current !== roundId) {
        URL.revokeObjectURL(resultUrl);
        return;
      }
      continuousCameraUrlsRef.current.add(resultUrl);

      setContinuousCameraRound({
        status: 'done',
        originalUrl,
        resultUrl,
      });
      pwaInstall.offerAfterSuccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (continuousCameraRoundIdRef.current === roundId) {
        setContinuousCameraRound({
          status: 'error',
          originalUrl,
          error: message,
        });
      }
    } finally {
      continuousCameraCaptureActiveRef.current = false;
      void refreshStorage();
    }
  };

  useEffect(() => {
    const handleWorkbenchShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && !event.altKey && key === 'o') {
        if (
          activeView === 'workbench'
          && !importing
          && !storageHardBlocked
          && !(resumeHistoryBatchId && !batchRunning)
        ) {
          event.preventDefault();
          fileInputRef.current?.click();
        }
        return;
      }
      if (commandKey && !event.altKey && key === 'enter') {
        if (activeView !== 'workbench') return;
        if (batchRunning) {
          event.preventDefault();
          stopBatch();
        } else if (startAllowed) {
          event.preventDefault();
          void startBatch();
        }
        return;
      }
      if (
        event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && (key === '1' || key === '2' || key === '3')
      ) {
        event.preventDefault();
        setActiveView('workbench');
        setMobilePane(key === '1' ? 'queue' : key === '2' ? 'preview' : 'settings');
      }
    };

    window.addEventListener('keydown', handleWorkbenchShortcut);
    return () => window.removeEventListener('keydown', handleWorkbenchShortcut);
  }, [
    activeView,
    batchRunning,
    importing,
    resumeHistoryBatchId,
    startAllowed,
    storageHardBlocked,
    startBatch,
    stopBatch,
  ]);

  const modelProgressPercent = Math.min(
    100,
    Math.round(
      (modelPackageState.storedBytes / Math.max(1, modelPackageState.totalBytes)) * 100,
    ),
  );
  const capabilityFailureDetail = (
    queueRuntimeDecision.status === 'blocked'
    && queueRuntimeDecision.code === 'CAPABILITY_FAILED'
  )
    ? runtimeBlockerMessage(queueRuntimeDecision)
    : undefined;
  const modelGateState = capabilityFailureDetail
    ? 'error'
    : modelPackageState.status === 'installed'
    ? modelRuntimeProbe.status === 'ready'
      ? 'ready'
      : modelRuntimeProbe.status === 'failed'
        ? 'error'
        : 'pending'
    : modelPackageState.status === 'failed'
      ? 'error'
      : 'pending';
  const modelGateDetail = capabilityFailureDetail
    ?? (modelPackageState.status === 'checking'
    ? copy.modelGateChecking
    : modelPackageState.status === 'installed'
      ? modelRuntimeProbe.status === 'ready'
        ? copy.modelGateReady
        : modelRuntimeProbe.status === 'failed'
          ? copy.modelGateProbeFailed
          : modelRuntimeProbe.status === 'checking'
            ? copy.modelGateProbing(
              modelRuntimeProbe.progress?.modelId ?? 'runtime',
              modelRuntimeProbe.progress?.completed ?? 0,
              modelRuntimeProbe.progress?.total ?? 4,
            )
            : copy.modelGateChecking
      : modelPackageState.status === 'installing'
        ? modelPackageState.progress?.phase === 'verifying'
          ? copy.modelGateVerifying
          : copy.modelGateInstalling
        : modelPackageState.status === 'paused'
          ? copy.modelGatePaused
      : modelPackageState.status === 'failed'
            ? copy.modelGateFailed
            : copy.modelGatePending);
  const startBlockerDetail = queue.length === 0
    ? copy.queueRequired
    : storageImportIssue
      ?? runtimeBlockerMessage(queueRuntimeDecision);
  const queueRuntimeBlockerCode = queueRuntimeDecision.status === 'blocked'
    ? queueRuntimeDecision.code
    : undefined;
  const modelInstallActionAvailable = (
    queueRuntimeBlockerCode === 'MODEL_CONSENT_REQUIRED'
    || queueRuntimeBlockerCode === 'MODEL_PACKAGE_MISSING'
    || queueRuntimeBlockerCode === 'MODEL_INSTALL_PAUSED'
    || queueRuntimeBlockerCode === 'MODEL_INSTALL_FAILED'
  );
  const modelProbeRetryAvailable = (
    queueRuntimeBlockerCode === 'MODEL_PROBE_FAILED'
    || queueRuntimeBlockerCode === 'CAPABILITY_FAILED'
  );
  const primaryActionLabel = batchRunning
    ? copy.stopBatch
    : startAllowed
      ? copy.start
      : storageImportIssue
          ? copy.settings
          : queue.length === 0
            ? copy.addImages
          : modelInstallActionAvailable
            ? !modelConsent
              ? copy.modelConsent
              : modelPackageState.status === 'paused'
                ? copy.modelResume
                : copy.modelRetry
            : modelProbeRetryAvailable
              ? copy.modelProbeRetry
              : providerValidationError
                ? copy.openProviderSettings
                : copy.start;
  const primaryActionIconName: IconName = batchRunning
    ? 'stop'
    : startAllowed
      ? 'play'
      : storageImportIssue
        ? 'gear'
        : queue.length === 0
          ? 'add'
          : modelInstallActionAvailable
            ? 'download'
            : modelProbeRetryAvailable
              ? 'refresh'
              : providerValidationError
                ? 'gear'
                : 'play';
  const primaryActionDisabled = (
    !batchRunning
    && !startAllowed
    && queue.length > 0
    && !storageImportIssue
    && !modelInstallActionAvailable
    && !modelProbeRetryAvailable
    && !providerValidationError
  );
  const handlePrimaryAction = (): void => {
    if (batchRunning) {
      stopBatch();
      return;
    }
    if (startAllowed) {
      void startBatch();
      return;
    }
    if (storageImportIssue) {
      setActiveView('settings');
      void refreshStorage();
      return;
    }
    if (queue.length === 0) {
      fileInputRef.current?.click();
      return;
    }
    if (modelInstallActionAvailable) {
      acceptModelDownload();
      return;
    }
    if (modelProbeRetryAvailable) {
      void processingRuntime.dispatch({ type: 'retry' }).catch((error) => {
        setBatchNotice(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (providerValidationError) {
      setProviderDetailsOpen(true);
      setMobilePane('settings');
    }
  };
  const visiblePreviewUrl = (
    previewMode === 'result' && selectedJob?.resultUrl
      ? selectedJob.resultUrl
      : previewUrl
  );
  const previewScaleLabel = previewScale === 'fit'
    ? copy.previewFit
    : `${Math.round(previewScale * 100)}%`;
  const adjustPreviewScale = (direction: -1 | 1): void => {
    setPreviewScale((current) => {
      const currentScale = current === 'fit' ? 1 : current;
      const currentIndex = previewZoomSteps.indexOf(currentScale);
      const nextIndex = Math.max(
        0,
        Math.min(
          previewZoomSteps.length - 1,
          (currentIndex < 0 ? previewZoomSteps.indexOf(1) : currentIndex) + direction,
        ),
      );
      return previewZoomSteps[nextIndex];
    });
  };
  const activeProgress = queue
    .map((image) => jobs[image.id])
    .find((job) => job?.status === 'running')
    ?.progress;
  const mobileTaskDetail = batchRunning
    ? activeProgress?.detail ?? copy.batchRunning
    : batchNotice
      || storageImportIssue
      || (startAllowed ? copy.localMode : startBlockerDetail);

  return (
    <div
      className="app-shell"
      data-dragging={dragging}
      onDragEnter={activeView === 'workbench' ? handleDragEnter : undefined}
      onDragLeave={activeView === 'workbench' ? handleDragLeave : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDrop={activeView === 'workbench' ? handleDrop : undefined}
    >
      <header className="topbar">
        <button
          className="brand brand-button"
          type="button"
          aria-label={copy.workbench}
          onClick={() => setActiveView('workbench')}
        >
          <img className="brand-icon" src={brandIconUrl} alt="" />
          <div className="brand-copy">
            <div className="brand-title-row">
              <img
                className="brand-wordmark"
                src={brandWordmarkUrl}
                alt="Shinobu Translator"
              />
              <span className="web-badge">{copy.webBadge}</span>
            </div>
            <span className="brand-subtitle">{copy.appSubtitle}</span>
          </div>
        </button>

        <nav className="topnav" aria-label="Primary">
          <button
            className={`topnav-item ${activeView === 'workbench' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'workbench' ? 'page' : undefined}
            onClick={() => setActiveView('workbench')}
          >
            <Icon name="queue" />
            {copy.workbench}
          </button>
          <button
            className={`topnav-item ${activeView === 'history' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'history' ? 'page' : undefined}
            onClick={() => {
              setActiveView('history');
              setHistoryActionError(undefined);
              void localHistory.lifecycle.request({ type: 'refresh' });
            }}
          >
            <Icon name="clock" />
            {copy.history}
          </button>
          <button
            className={`topnav-item ${activeView === 'settings' ? 'topnav-item-active' : ''}`}
            type="button"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            onClick={() => {
              setActiveView('settings');
              void refreshStorage();
            }}
          >
            <Icon name="gear" />
            {copy.settingsTitle}
          </button>
        </nav>

        <div className="topbar-actions">
          <nav className="mobile-view-nav" aria-label="Primary">
            <button
              className="mobile-view-trigger"
              type="button"
              aria-label={copy.history}
              aria-current={activeView === 'history' ? 'page' : undefined}
              onClick={() => {
                setActiveView('history');
                setHistoryActionError(undefined);
                void localHistory.lifecycle.request({ type: 'refresh' });
              }}
            >
              <Icon name="clock" />
            </button>
            <button
              className="mobile-view-trigger"
              type="button"
              aria-label={copy.settingsTitle}
              aria-current={activeView === 'settings' ? 'page' : undefined}
              onClick={() => {
                setActiveView('settings');
                void refreshStorage();
              }}
            >
              <Icon name="gear" />
            </button>
          </nav>
          <button
            className="install-trigger"
            type="button"
            disabled={pwaInstall.installed}
            onClick={() => void pwaInstall.requestInstall()}
          >
            <Icon name="add" />
            <span>{pwaInstall.installed ? copy.appInstalled : copy.installApp}</span>
          </button>
          <div className="locale-switch" aria-label="界面语言">
            <button
              type="button"
              className={settings.uiLocale === 'zh-CN' ? 'locale-active' : ''}
              aria-pressed={settings.uiLocale === 'zh-CN'}
              onClick={() => patchSettings({ uiLocale: 'zh-CN' as UiLocale })}
            >
              简
            </button>
            <button
              type="button"
              className={settings.uiLocale === 'zh-TW' ? 'locale-active' : ''}
              aria-pressed={settings.uiLocale === 'zh-TW'}
              onClick={() => patchSettings({ uiLocale: 'zh-TW' as UiLocale })}
            >
              繁
            </button>
          </div>
        </div>
      </header>

      {pwa.updateReady && (
        <div className="update-banner" role="status">
          <strong>{copy.updateReady}</strong>
          <button
            className="button button-secondary button-compact"
            type="button"
            disabled={batchRunning}
            onClick={pwa.activateUpdate}
          >
            {copy.applyUpdate}
          </button>
        </div>
      )}

      {pwaInstall.suggestionVisible && !pwaInstall.installed && (
        <div className="install-prompt" role="dialog" aria-labelledby="install-prompt-title">
          <strong id="install-prompt-title">{copy.installTitle}</strong>
          <div>
            {pwaInstall.nativeAvailable && (
              <button
                className="button button-primary button-compact"
                type="button"
                onClick={() => void pwaInstall.requestInstall()}
              >
                {copy.installNow}
              </button>
            )}
            <button
              className="button button-secondary button-compact"
              type="button"
              onClick={pwaInstall.dismissSuggestion}
            >
              {copy.notNow}
            </button>
          </div>
        </div>
      )}

      {activeView === 'workbench' ? (
        <>
      <main className="workspace" data-mobile-pane={mobilePane}>
        <aside className="workspace-pane queue-pane" aria-label={copy.queue}>
          <div className="pane-header">
            <div>
              <h1>{copy.queue}</h1>
              <p>{copy.queueCount(queue.length)} · {copy.totalSize(formatBytes(totalBytes))}</p>
            </div>
            <input
              ref={fileInputRef}
              id="web-image-import"
              name="image-import"
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              accept=".png,.jpg,.jpeg,.webp,.avif,image/png,image/jpeg,image/webp,image/avif"
              multiple
              disabled={storageHardBlocked}
              onChange={handleFileInput}
            />
            <div className="import-actions">
              <button
                className="button button-secondary button-compact camera-action"
                type="button"
                title={continuousCameraAllowed
                  ? copy.continuousCamera
                  : continuousCameraBlocker}
                disabled={
                  batchRunning
                  || importing
                  || Boolean(resumeHistoryBatchId)
                }
                onClick={handleContinuousCameraEntry}
              >
                <Icon name="camera" />
                {copy.cameraCapture}
              </button>
              <button
                className="button button-secondary button-compact"
                type="button"
                aria-keyshortcuts="Control+O Meta+O"
                title={`${copy.addImages} (Ctrl/⌘+O)`}
                disabled={
                  importing
                  || storageHardBlocked
                  || Boolean(resumeHistoryBatchId && !batchRunning)
                }
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="add" />
                {importing ? copy.importing : copy.addImages}
              </button>
            </div>
          </div>

          {storageImportIssue && (
            <div className="storage-import-warning" role="alert">
              <Icon name="warning" />
              <span>{storageImportIssue}</span>
              <button
                type="button"
                onClick={() => {
                  setActiveView('settings');
                  void refreshStorage();
                }}
              >
                {copy.settings}
              </button>
            </div>
          )}

          {queue.length === 0 ? (
            <div className="queue-empty">
              <div className="empty-illustration" aria-hidden="true">
                <Icon name="image" />
                <span><Icon name="add" /></span>
              </div>
              <h2>{copy.queueEmptyTitle}</h2>
              <p>{copy.queueEmptyBody}</p>
              <button
                className="button button-primary"
                type="button"
                aria-keyshortcuts="Control+O Meta+O"
                title={`${copy.addImages} (Ctrl/⌘+O)`}
                disabled={
                  importing
                  || storageHardBlocked
                  || Boolean(resumeHistoryBatchId && !batchRunning)
                }
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="add" />
                {copy.addImages}
              </button>
            </div>
          ) : (
            <ol className="queue-list">
              {queue.map((image, index) => {
                const selected = selectedId === image.id;
                const job = jobs[image.id];
                const previousJob = index > 0 ? jobs[queue[index - 1].id] : undefined;
                const nextJob = index < queue.length - 1
                  ? jobs[queue[index + 1].id]
                  : undefined;
                return (
                  <li
                    className="queue-item"
                    data-selected={selected}
                    key={image.id}
                    style={{ animationDelay: `${Math.min(index, 7) * 24}ms` }}
                  >
                    <button
                      className="queue-select"
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(image.id);
                        setMobilePane('preview');
                      }}
                    >
                      <span className="queue-index">{String(index + 1).padStart(2, '0')}</span>
                      <img src={image.thumbnailUrl} alt="" />
                      <span className="queue-copy">
                        <strong title={image.file.name}>{image.file.name}</strong>
                        <span>{copy.imageMeta(image.width, image.height, formatBytes(image.file.size))}</span>
                        <span className="queue-badges">
                          {image.duplicate && <em>{copy.duplicate}</em>}
                          {image.workingCopy.required && <em>{copy.workingCopy}</em>}
                          {job && (
                            <em data-job-status={job.status}>
                              {jobStatusLabel(job.status)}
                            </em>
                          )}
                        </span>
                        {job?.status === 'running' && job.progress && (
                          <span className="queue-progress">{job.progress.detail}</span>
                        )}
                        {job?.error && <span className="queue-error">{job.error}</span>}
                      </span>
                    </button>
                    <span className="queue-actions">
                      {(job?.status === 'failed' || job?.status === 'cancelled') && (
                        <button
                          type="button"
                          aria-label={copy.retryTask}
                          title={copy.retryTask}
                          disabled={!activeProcessingBatchRef.current}
                          onClick={() => retryTask(image.id)}
                        >
                          <Icon name="refresh" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={
                          importing
                          || job?.status === 'running'
                          || index === 0
                          || (
                            Boolean(resumeHistoryBatchId || batchRunning)
                            && (
                              job?.status !== 'queued'
                              || previousJob?.status !== 'queued'
                            )
                          )
                        }
                        aria-label={copy.moveUp}
                        title={copy.moveUp}
                        onClick={() => void moveImage(image.id, -1)}
                      >
                        <Icon name="arrow-up" />
                      </button>
                      <button
                        type="button"
                        disabled={
                          importing
                          || job?.status === 'running'
                          || index === queue.length - 1
                          || (
                            Boolean(resumeHistoryBatchId || batchRunning)
                            && (
                              job?.status !== 'queued'
                              || nextJob?.status !== 'queued'
                            )
                          )
                        }
                        aria-label={copy.moveDown}
                        title={copy.moveDown}
                        onClick={() => void moveImage(image.id, 1)}
                      >
                        <Icon name="arrow-down" />
                      </button>
                      <button
                        type="button"
                        disabled={
                          importing
                          || job?.status === 'running'
                          || (
                            Boolean(resumeHistoryBatchId || batchRunning)
                            && job?.status !== 'queued'
                          )
                        }
                        aria-label={copy.remove}
                        title={copy.remove}
                        onClick={() => void removeImage(image.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {rejections.length > 0 && (
            <section className="import-issues" aria-live="polite">
              <div className="issues-header">
                <h2><Icon name="warning" />{copy.issues} ({rejections.length})</h2>
                <button type="button" onClick={() => setRejections([])}>{copy.clearIssues}</button>
              </div>
              <ul>
                {rejections.map((rejection, index) => (
                  <li key={`${rejection.file.name}-${rejection.file.lastModified}-${index}`}>
                    <strong>{rejection.file.name}</strong>
                    <span>{describeImportRejection(settings.uiLocale, rejection.code)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <section className="workspace-pane preview-pane" aria-label={copy.preview}>
          <div className="pane-header preview-header">
            <div>
              <h1>{copy.preview}</h1>
              {selectedImage && (
                <p>
                  {copy.imageMeta(
                    selectedImage.width,
                    selectedImage.height,
                    formatBytes(selectedImage.file.size),
                  )}
                </p>
              )}
            </div>
            <div
              className="preview-tabs"
              data-mode={previewMode}
              aria-label={copy.preview}
            >
              <span className="preview-tab-indicator" aria-hidden="true" />
              <button
                type="button"
                aria-pressed={previewMode === 'original'}
                onClick={() => setPreviewMode('original')}
              >
                {copy.original}
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'result'}
                disabled={selectedJob?.status !== 'done'}
                title={selectedJob?.status === 'done' ? undefined : copy.compareUnavailable}
                onClick={() => setPreviewMode('result')}
              >
                {copy.result}
              </button>
            </div>
          </div>

          <div className="preview-stage">
            {selectedImage && visiblePreviewUrl ? (
              <>
                <div className="preview-toolbar" aria-label={copy.previewZoom}>
                  <button
                    type="button"
                    aria-label={copy.zoomOut}
                    title={copy.zoomOut}
                    disabled={previewScale !== 'fit' && previewScale <= previewZoomSteps[0]}
                    onClick={() => adjustPreviewScale(-1)}
                  >
                    <Icon name="zoom-out" />
                  </button>
                  <button
                    className="preview-scale-button"
                    type="button"
                    aria-label={copy.previewFit}
                    title={copy.previewFit}
                    data-active={previewScale === 'fit'}
                    onClick={() => setPreviewScale('fit')}
                  >
                    <Icon name="fit" />
                    <span>{previewScaleLabel}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={copy.zoomIn}
                    title={copy.zoomIn}
                    disabled={previewScale !== 'fit'
                      && previewScale >= previewZoomSteps[previewZoomSteps.length - 1]}
                    onClick={() => adjustPreviewScale(1)}
                  >
                    <Icon name="zoom-in" />
                  </button>
                </div>
                <div
                  className="image-canvas"
                  data-view={previewScale === 'fit' ? 'fit' : 'zoom'}
                >
                  <img
                    key={`${selectedImage.id}:${previewMode}`}
                    src={visiblePreviewUrl}
                    alt={selectedImage.file.name}
                    draggable={false}
                    style={previewScale === 'fit'
                      ? undefined
                      : { width: `${Math.round(selectedImage.width * previewScale)}px` }}
                  />
                </div>
                <div className="preview-meta">
                  <div>
                    <strong>{selectedImage.file.name}</strong>
                    <span>
                      {selectedImage.format.toUpperCase()} · {formatBytes(selectedImage.file.size)}
                    </span>
                  </div>
                  <div>
                    <strong>{selectedImage.width} × {selectedImage.height}</strong>
                    <span>
                      {selectedImage.workingCopy.required
                        ? copy.workMeta(
                            selectedImage.workingCopy.width,
                            selectedImage.workingCopy.height,
                            selectedImage.workingCopy.scale,
                          )
                        : `${(selectedImage.pixelCount / 1_000_000).toFixed(1)} MP`}
                    </span>
                  </div>
                </div>
                {selectedJob?.status === 'running' && selectedJob.progress && (
                  <div className="task-callout" data-state="running" aria-live="polite">
                    <strong>{copy.statusRunning}</strong>
                    <span>{selectedJob.progress.detail}</span>
                  </div>
                )}
                {selectedJob?.error && (
                  <div className="task-callout" data-state="failed" role="alert">
                    <strong>{jobStatusLabel(selectedJob.status)}</strong>
                    <span>{selectedJob.error}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="preview-empty">
              <div className="preview-empty-symbol"><Icon name="image" /></div>
              <h2>{copy.previewEmptyTitle}</h2>
                <p>{copy.previewEmptyBody}</p>
                <button
                  className="button button-primary camera-empty-action"
                  type="button"
                  title={continuousCameraAllowed
                    ? copy.continuousCamera
                    : continuousCameraBlocker}
                  disabled={
                    batchRunning
                    || importing
                    || Boolean(resumeHistoryBatchId)
                  }
                  onClick={handleContinuousCameraEntry}
                >
                  <Icon name="camera" />
                  {copy.cameraCapture}
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="workspace-pane settings-pane" aria-label={copy.batchSettings}>
          <div className="pane-header">
            <h1>{copy.batchSettings}</h1>
          </div>

          <div className="settings-content">
            <form
              className="settings-section"
              onSubmit={(event) => event.preventDefault()}
            >
              <h2>{copy.processMode}</h2>
              <div className="segmented-control" role="radiogroup" aria-label={copy.processMode}>
                <span
                  className="segmented-indicator"
                  data-mode={settings.processMode}
                  aria-hidden="true"
                />
                {processModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={settings.processMode === mode}
                    data-active={settings.processMode === mode}
                    disabled={batchRunning || Boolean(resumeHistoryBatchId)}
                    onClick={() => patchSettings({ processMode: mode })}
                  >
                    {modeLabel(mode)}
                  </button>
                ))}
              </div>

              <label className="field">
                <span>{copy.targetLanguage}</span>
                <select
                  id="batch-target-language"
                  name="target-language"
                  value={settings.targetLanguage}
                  disabled={batchRunning || Boolean(resumeHistoryBatchId)}
                  onChange={(event) =>
                    patchSettings({ targetLanguage: event.target.value as TargetLanguage })}
                >
                  <option value="zh-CHS">{copy.simplifiedChinese}</option>
                  <option value="zh-CHT">{copy.traditionalChinese}</option>
                </select>
              </label>

              <label className="field">
                <span>{copy.provider}</span>
                <select
                  id="batch-translation-provider"
                  name="translation-provider"
                  value={settings.translationProviderId}
                  disabled={
                    batchRunning
                    || Boolean(resumeHistoryBatchId)
                    || settings.processMode !== 'translate'
                  }
                  onChange={(event) =>
                    patchSettings({
                      translationProviderId: event.target.value as TranslationProviderId,
                    })}
                >
                  {translationProviderOptions.map((provider) => (
                    <option value={provider.id} key={provider.id}>{provider.label}</option>
                  ))}
                </select>
              </label>
              {settings.processMode === 'translate' && (
                <details
                  className="provider-disclosure"
                  open={providerDetailsOpen}
                  onToggle={(event) => setProviderDetailsOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>
                      <strong>{copy.providerSettingsTitle}</strong>
                      <small>
                        {providerReady ? copy.providerReady : copy.providerGatePending}
                      </small>
                    </span>
                    <span className="provider-disclosure-action" aria-hidden="true">
                      <Icon name="chevron-down" />
                    </span>
                  </summary>
                  <div className="workspace-provider-fields">
                    <div className="workspace-provider-grid">
                      <label className="field">
                        <span>{copy.baseUrl}</span>
                        <input
                          id="batch-provider-base-url"
                          name="provider-base-url"
                          type="url"
                          value={activeProviderProfile.baseUrl}
                          disabled={batchRunning || Boolean(resumeHistoryBatchId)}
                          spellCheck={false}
                          onChange={(event) =>
                            patchActiveProviderProfile({ baseUrl: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{copy.model}</span>
                        <input
                          id="batch-provider-model"
                          name="provider-model"
                          type="text"
                          value={activeProviderProfile.model}
                          disabled={batchRunning || Boolean(resumeHistoryBatchId)}
                          spellCheck={false}
                          onChange={(event) =>
                            patchActiveProviderProfile({ model: event.target.value })}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>{copy.apiKey}</span>
                      <input
                        id="batch-provider-api-key"
                        name="provider-api-key"
                        type="password"
                        value={activeProviderSecret.value}
                        disabled={
                          batchRunning
                          || Boolean(resumeHistoryBatchId)
                          || activeProviderSecret.busy
                        }
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => updateProviderKey(event.target.value)}
                      />
                      {activeProviderSecret.restoreStatus === 'restoring' && (
                        <small>{copy.deviceKeyRestoring}</small>
                      )}
                      {activeProviderSecret.restoreStatus === 'target-mismatch' && (
                        <small className="field-error" role="alert">
                          {copy.deviceKeyTargetMismatch}
                        </small>
                      )}
                      {activeProviderSecret.restoreStatus === 'corrupt' && (
                        <small className="field-error" role="alert">
                          {copy.deviceKeyCorrupt}
                        </small>
                      )}
                      {activeProviderSecret.error && (
                        <small className="field-error" role="alert">
                          {activeProviderSecret.error}
                        </small>
                      )}
                    </label>
                    <div className="provider-config-actions">
                      <label className="remember-control">
                        <input
                          id="batch-remember-device"
                          name="remember-provider-key"
                          type="checkbox"
                          checked={activeProviderSecret.persistence === 'device'}
                          disabled={
                            batchRunning
                            || Boolean(resumeHistoryBatchId)
                            || activeProviderSecret.busy
                            || !activeProviderSecret.value.trim()
                          }
                          onChange={(event) => {
                            const action = event.target.checked
                              ? providerSecrets.remember(settings.translationProviderId)
                              : providerSecrets.forget(settings.translationProviderId);
                            void action.catch(() => undefined);
                          }}
                        />
                        <span>{copy.rememberDevice}</span>
                      </label>
                      <button
                        className="delete-config"
                        type="button"
                        disabled={batchRunning || Boolean(resumeHistoryBatchId)}
                        onClick={() => void removeActiveProviderConfiguration()}
                      >
                        {copy.deleteProviderConfig}
                      </button>
                    </div>
                    {providerConfigurationError && (
                      <small className="provider-error" role="alert">
                        {providerConfigurationError}
                      </small>
                    )}
                  </div>
                </details>
              )}
            </form>

            <section className="settings-section runtime-section model-download-section">
              <h2>{copy.modelGate}</h2>
              <div className="readiness-row" data-state={modelGateState}>
                <span className="readiness-icon">
                  <Icon name={modelGateState === 'ready' ? 'check' : 'clock'} />
                </span>
                <span>
                  <strong>{modelGateDetail}</strong>
                  {modelProbeRetryAvailable && (
                    <>
                      {(capabilityFailureDetail
                        ?? (modelRuntimeProbe.status === 'failed'
                          ? modelRuntimeProbe.error
                          : undefined)) && (
                        <small className="model-error" role="alert">
                          {capabilityFailureDetail
                            ?? (modelRuntimeProbe.status === 'failed'
                              ? modelRuntimeProbe.error
                              : '')}
                        </small>
                      )}
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => {
                          void processingRuntime.dispatch({ type: 'retry' });
                        }}
                      >
                        {copy.modelProbeRetry}
                      </button>
                    </>
                  )}
                  {modelPackageState.status !== 'installed' && (
                    <>
                      {modelPackageState.storedBytes > 0 && (
                        <small>
                          {copy.modelDownloadProgress(
                            modelProgressPercent,
                            formatBytes(modelPackageState.storedBytes),
                            formatBytes(modelPackageState.totalBytes),
                          )}
                        </small>
                      )}
                      {modelPackageState.status === 'installing' && (
                        <progress
                          className="model-progress"
                          max={modelPackageState.totalBytes}
                          value={modelPackageState.storedBytes}
                          aria-label={copy.modelGateInstalling}
                        />
                      )}
                      {modelPackageState.error && (
                        <small className="model-error" role="alert">
                          {modelPackageState.error}
                        </small>
                      )}
                      {modelPackageState.status === 'installing' ? (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => {
                            void processingRuntime.dispatch({ type: 'cancel-model-download' });
                          }}
                        >
                          {copy.modelCancel}
                        </button>
                      ) : modelPackageState.status !== 'checking' && (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={acceptModelDownload}
                        >
                          {!modelConsent
                            ? copy.modelConsent
                            : modelPackageState.status === 'paused'
                              ? copy.modelResume
                              : copy.modelRetry}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {batchRunning && (
                <div className="task-controls">
                  <span>{copy.batchRunning}</span>
                  <button
                    className="button button-secondary button-compact"
                    type="button"
                    onClick={cancelCurrent}
                    disabled={!activeProcessingBatchRef.current?.snapshot().currentTaskId}
                  >
                    {copy.cancelCurrent}
                  </button>
                </div>
              )}
            </section>

          </div>

          <div className="run-footer">
            {!batchRunning && (
              <p className="run-hint" aria-live="polite">
                {startAllowed ? copy.localMode : startBlockerDetail}
              </p>
            )}
            <button
              className="button button-primary button-run"
              type="button"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title={`${batchRunning ? copy.stopBatch : copy.start} (Ctrl/⌘+Enter)`}
              disabled={primaryActionDisabled}
              onClick={handlePrimaryAction}
            >
              <Icon name={primaryActionIconName} weight="bold" />
              {primaryActionLabel}
            </button>
            {resumeHistoryBatchId && !batchRunning && (
              <button
                className="button button-secondary button-compact"
                type="button"
                onClick={exitHistoryResume}
              >
                {copy.historyExitResume}
              </button>
            )}
          </div>
        </aside>
      </main>

      {(batchRunning || mobilePane === 'settings') && (
      <div className="mobile-task-bar" aria-live="polite">
        <span title={mobileTaskDetail}>{mobileTaskDetail}</span>
        <button
          className="button button-primary button-compact"
          type="button"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title={`${batchRunning ? copy.stopBatch : copy.start} (Ctrl/⌘+Enter)`}
          disabled={primaryActionDisabled}
          onClick={handlePrimaryAction}
        >
          <Icon name={primaryActionIconName} weight="bold" />
          {primaryActionLabel}
        </button>
      </div>
      )}

      <nav className="mobile-nav" aria-label="Workspace">
        <button
          type="button"
          aria-keyshortcuts="Alt+1"
          title={`${copy.queue} (Alt+1)`}
          data-active={mobilePane === 'queue'}
          onClick={() => setMobilePane('queue')}
        >
          <Icon name="queue" />
          {copy.queue}
          {queue.length > 0 && <span>{queue.length}</span>}
        </button>
        <button
          type="button"
          aria-keyshortcuts="Alt+2"
          title={`${copy.preview} (Alt+2)`}
          data-active={mobilePane === 'preview'}
          onClick={() => setMobilePane('preview')}
        >
          <Icon name="image" />
          {copy.preview}
        </button>
        <button
          type="button"
          aria-keyshortcuts="Alt+3"
          title={`${copy.batchSettings} (Alt+3)`}
          data-active={mobilePane === 'settings'}
          onClick={() => setMobilePane('settings')}
        >
          <Icon name="settings" />
          {copy.batchSettings}
        </button>
      </nav>
        </>
      ) : activeView === 'history' ? (
        <HistoryView
          copy={copy}
          locale={settings.uiLocale}
          entries={historySnapshot.entries}
          loading={historySnapshot.status === 'loading'}
          busy={historySnapshot.busy}
          error={
            historyActionError
            ?? historyCleanupFaultMessage
            ?? (historySnapshot.failure
              ? `${historySnapshot.failure.operation}: ${historySnapshot.failure.cause}`
              : undefined)
          }
          onRefresh={() => void handleHistoryOutcome({ type: 'refresh' })}
          onResume={(batchId) => void handleHistoryOutcome({
            type: 'prepare-resume',
            batchId,
          })}
          onClone={(batchId) => void handleHistoryOutcome({
            type: 'prepare-clone',
            batchId,
          })}
          onDownload={(batchId, itemId) => void handleHistoryOutcome({
            type: 'download-result',
            batchId,
            itemId,
          })}
          onExportResults={(batchId) => void handleHistoryOutcome({
            type: 'export-results',
            batchId,
          })}
          onExportProject={(batchId) => void exportHistoryProject(batchId)}
          onImportProject={(file) => void handleHistoryOutcome({
            type: 'import-project',
            file,
          })}
          onKeepResults={(batchId) => void keepHistoryResultsOnly(batchId)}
          onDelete={(batchId) => void handleHistoryOutcome({
            type: 'stage-delete',
            batchId,
          })}
        />
      ) : (
        <SettingsView
          copy={copy}
          settings={settings}
          historyLocked={Boolean(resumeHistoryBatchId)}
          storageSnapshot={storageSnapshot}
          storageChecking={storageChecking}
          diagnosticBusy={diagnosticBusy}
          onLocaleChange={(locale) => patchSettings({ uiLocale: locale })}
          onRefreshStorage={() => {
            void refreshStorage();
          }}
          onManageHistory={() => {
            setActiveView('history');
            setHistoryActionError(undefined);
            void localHistory.lifecycle.request({ type: 'refresh' });
          }}
          onExportDiagnostics={() => {
            void exportRedactedDiagnostics();
          }}
        />
      )}

      {continuousCameraOpen && (
        <ContinuousCamera
          copy={copy}
          round={continuousCameraRound}
          onCapture={translateContinuousCameraCapture}
          onNext={continueContinuousCamera}
          onExit={closeContinuousCamera}
        />
      )}

      {historySnapshot.pending && (
        <div className="undo-toast" role="status">
          <span>
            {historySnapshot.pending.type === 'delete'
              ? copy.historyDeletePending
              : copy.historyKeepResults}
          </span>
          <button
            type="button"
            onClick={() => void handleHistoryOutcome({ type: 'undo-pending' })}
          >
            {copy.historyUndoDelete}
          </button>
        </div>
      )}

      {dragging && activeView === 'workbench' && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="add" />
            <strong>{copy.dropHint}</strong>
          </div>
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">
        {importing ? copy.importing : ''}
      </span>
    </div>
  );
}
