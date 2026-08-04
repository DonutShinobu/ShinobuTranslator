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
  decodeWebSettings,
  defaultWebProviderProfiles,
  encodeWebSettings,
  normalizeProviderTargetBinding,
  translationProviderOptions,
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
import { ContinuousCamera } from './features/camera/ContinuousCamera';
import { decodeBrowserImage } from './features/import/browserImageDecoder';
import {
  createImageImporter,
  imageImportLimitsForDevice,
} from './features/import/imageImporter';
import { useProviderSecrets } from './features/providers/useProviderSecrets';
import {
  type QueueJobStatus,
  type WebWorkbenchHistoryAction,
  type WebWorkbenchHistoryRejectionCode,
} from './features/workbench/webWorkbench';
import { createBrowserWorkbenchDiagnostics } from './features/workbench/browserWorkbenchDiagnostics';
import { createBrowserWebWorkbench } from './features/workbench/browserWebWorkbench';
import { useWebWorkbench } from './features/workbench/useWebWorkbench';
import {
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
  code: WebWorkbenchHistoryRejectionCode,
  locale: UiLocale,
): string {
  const traditional = locale === 'zh-TW';
  const messages: Record<WebWorkbenchHistoryRejectionCode, [string, string]> = {
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
  const initialSettingsRef = useRef<WebSettings>(readInitialSettings());
  const [activeView, setActiveView] = useState<ActiveView>('workbench');
  const [dragging, setDragging] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('preview');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('original');
  const [previewScale, setPreviewScale] = useState<PreviewScale>('fit');
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const pwa = usePwaLifecycle();
  const pwaInstall = usePwaInstall();
  const deviceProfile = useMemo(() => detectWebDeviceProfile(), []);
  const diagnosticLifecycleRef = useRef({
    online: pwa.online,
    offlineReady: pwa.offlineReady,
    updateReady: pwa.updateReady,
    visibilityState: document.visibilityState,
  });
  diagnosticLifecycleRef.current = {
    online: pwa.online,
    offlineReady: pwa.offlineReady,
    updateReady: pwa.updateReady,
    visibilityState: document.visibilityState,
  };
  const diagnostics = useMemo(() => createBrowserWorkbenchDiagnostics({
    versions: LOCAL_HISTORY_VERSIONS,
    device: deviceProfile,
    lifecycle: () => diagnosticLifecycleRef.current,
  }), [deviceProfile]);
  const importerRef = useRef<ReturnType<typeof createImageImporter>>();
  if (!importerRef.current) {
    importerRef.current = createImageImporter({
      decodeImage: decodeBrowserImage,
      limits: imageImportLimitsForDevice(
        deviceProfile.mobile,
        deviceProfile.initialWorkPixelBudget,
      ),
    });
  }
  const settingsChangedRef = useRef<(next: WebSettings, previous: WebSettings) => void>(
    () => undefined,
  );
  const processingCompletedRef = useRef<() => void>(() => undefined);
  const credentialValuesRef = useRef<Partial<Record<TranslationProviderId, string>>>({});
  const credentialListenersRef = useRef(new Set<() => void>());
  const credentials = useMemo(() => ({
    status(settings: WebSettings) {
      const providerId = settings.translationProviderId;
      return {
        providerId,
        target: settings.providerProfiles[providerId].baseUrl,
        available: Boolean(credentialValuesRef.current[providerId]?.trim()),
      };
    },
    resolve(settings: WebSettings) {
      const providerId = settings.translationProviderId;
      return {
        providerId,
        target: settings.providerProfiles[providerId].baseUrl,
        value: credentialValuesRef.current[providerId] ?? '',
      };
    },
    subscribe(listener: () => void) {
      credentialListenersRef.current.add(listener);
      return () => credentialListenersRef.current.delete(listener);
    },
  }), []);

  const workbench = useMemo(() => createBrowserWebWorkbench({
    initialSettings: initialSettingsRef.current,
    importer: () => importerRef.current!,
    credentials,
    diagnostics,
    versions: LOCAL_HISTORY_VERSIONS,
    onSettingsChanged: (next, previous) => settingsChangedRef.current(next, previous),
    onProcessingCompleted: () => processingCompletedRef.current(),
  }), [credentials, diagnostics]);
  const workbenchSnapshot = useWebWorkbench(workbench);
  const {
    settings,
    images: queue,
    selectedImageId: selectedId,
    selectedPreviewUrl,
    jobs,
    itemActions,
    importing,
    rejections,
    notice: batchNotice,
    storageImportError,
    processing,
    runtime: runtimeView,
    provider: providerView,
    controls,
    primaryAction,
    diagnostics: diagnosticState,
    historyAction,
    camera: {
      open: continuousCameraOpen,
      round: continuousCameraRound,
      entry: cameraEntry,
    },
  } = workbenchSnapshot;
  const capability = runtimeView.capability ?? null;
  const modelPackageState = runtimeView.modelPackage;
  const modelRuntimeProbe = runtimeView.modelProbe;
  const modelConsent = runtimeView.modelConsent;
  const storageChecking = runtimeView.storage.status === 'checking';
  const storageSnapshot: WebStorageSnapshot | null =
    runtimeView.storage.status === 'checking'
      ? null
      : runtimeView.storage;
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
  importerRef.current = importer;
  const refreshStorage = useCallback(async (): Promise<WebStorageSnapshot> => {
    await workbench.dispatch({ type: 'refresh-storage' });
    const storage = workbench.snapshot().runtime.storage;
    if (storage.status === 'checking') {
      throw new Error('浏览器存储状态仍在检查');
    }
    return storage;
  }, [workbench]);
  const batchRunning = processing.status === 'running';
  const recoveryActive = workbenchSnapshot.phase === 'recovery';
  const processingSettingsEditable = controls.editProcessingSettings.status === 'available';
  const historySnapshot = workbenchSnapshot.history;
  const providerSecrets = useProviderSecrets(settings.providerProfiles);
  for (const provider of translationProviderOptions) {
    credentialValuesRef.current[provider.id] = providerSecrets.entries[provider.id].value;
  }
  useEffect(() => {
    for (const listener of credentialListenersRef.current) listener();
  }, [providerSecrets.entries]);
  settingsChangedRef.current = (nextSettings, previousSettings) => {
    const providerId = nextSettings.translationProviderId;
    let changed = true;
    try {
      changed = normalizeProviderTargetBinding(
        nextSettings.providerProfiles[providerId].baseUrl,
      ) !== normalizeProviderTargetBinding(
        previousSettings.providerProfiles[providerId].baseUrl,
      );
    } catch {
      // Invalid legacy targets must never retain a current provider secret.
    }
    if (changed) {
      credentialValuesRef.current[providerId] = '';
      providerSecrets.invalidateTarget(providerId);
    }
  };
  processingCompletedRef.current = () => {
    pwaInstall.offerAfterSuccess();
  };

  const copy = getCopy(settings.uiLocale);
  const historyCleanupFaultMessage = historySnapshot.cleanup.faultCount > 0
    ? settings.uiLocale === 'zh-TW'
      ? `${historySnapshot.cleanup.faultCount} 項本機資源仍待清理，尚未釋放 `
        + `${formatBytes(historySnapshot.cleanup.unreleasedBytes)}`
      : `${historySnapshot.cleanup.faultCount} 项本地资源仍待清理，尚未释放 `
        + `${formatBytes(historySnapshot.cleanup.unreleasedBytes)}`
    : undefined;
  const selectedImage = queue.find((image) => image.id === selectedId) ?? null;
  const selectedJob = selectedId ? jobs[selectedId] : undefined;
  const activeProviderProfile = settings.providerProfiles[settings.translationProviderId];
  const activeProviderSecret = providerSecrets.entries[settings.translationProviderId];
  const providerConfigurationError = providerView.configuration.status === 'blocked'
    ? providerView.configuration.reason === 'MODEL_MISSING'
      ? `${copy.model}不能为空`
      : providerView.configuration.reason === 'CREDENTIAL_MISSING'
        ? `${copy.apiKey}不能为空`
        : providerView.configuration.reason === 'CREDENTIAL_TARGET_MISMATCH'
          ? copy.startUnavailable
          : providerView.configuration.detail ?? copy.startUnavailable
    : null;
  const providerReady = providerView.configuration.status === 'available';
  const totalBytes = queue.reduce((sum, image) => sum + image.file.size, 0);
  const queueRuntimeDecision = runtimeView.queue;
  const runtimeBlockerMessage = (
    decision: typeof queueRuntimeDecision,
  ): string => {
    if (decision.status === 'available') return '';
    switch (decision.reason) {
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
  const storageImportIssue = storageImportError
    ?? (controls.importImages.status === 'blocked'
      && controls.importImages.reason === 'STORAGE_UNAVAILABLE'
      ? copy.storageUnavailable
      : controls.importImages.status === 'blocked'
        && controls.importImages.reason === 'INSUFFICIENT_STORAGE'
        ? copy.storageLow(formatBytes(controls.importImages.availableBytes ?? 0))
        : undefined);

  useEffect(() => {
    if (settings.processMode === 'translate') {
      setProviderDetailsOpen(providerConfigurationError !== null);
    }
  }, [providerConfigurationError, settings.processMode, settings.translationProviderId]);

  useEffect(() => {
    setPreviewScale('fit');
  }, [selectedId]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        void workbench.dispatch({ type: 'visibility-hidden' }).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [workbench]);

  useEffect(() => {
    document.documentElement.lang = settings.uiLocale;
    try {
      localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, encodeWebSettings(settings));
    } catch {
      // The workbench stays usable when preference persistence is unavailable.
    }
  }, [settings]);

  useEffect(() => {
    if (previewMode === 'result' && selectedJob?.status !== 'done') {
      setPreviewMode('original');
    }
  }, [previewMode, selectedJob?.status]);

  const importFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    await workbench.dispatch({ type: 'import-files', files });
    if (files.length > 0) setMobilePane('preview');
  }, [workbench]);

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
    if (
      !processingSettingsEditable
      && Object.keys(patch).some((key) => key !== 'uiLocale')
    ) {
      return;
    }
    void workbench.dispatch({
      type: 'update-settings',
      settings: { ...settings, ...patch },
    });
  };

  const patchActiveProviderProfile = (
    patch: Partial<WebSettings['providerProfiles'][TranslationProviderId]>,
  ): void => {
    if (!processingSettingsEditable) return;
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
        credentialValuesRef.current[providerId] = '';
        providerSecrets.invalidateTarget(providerId);
      }
    }
    void workbench.dispatch({
      type: 'update-settings',
      settings: {
        ...settings,
        providerProfiles: {
          ...settings.providerProfiles,
          [providerId]: {
            ...settings.providerProfiles[providerId],
            ...patch,
          },
        },
      },
    });
  };

  const updateProviderKey = (value: string): void => {
    credentialValuesRef.current[settings.translationProviderId] = value;
    providerSecrets.update(settings.translationProviderId, value);
  };

  const removeActiveProviderConfiguration = async (): Promise<void> => {
    if (!processingSettingsEditable) return;
    const providerId = settings.translationProviderId;
    credentialValuesRef.current[providerId] = '';
    await providerSecrets.clear(providerId);
    await workbench.dispatch({
      type: 'update-settings',
      settings: {
        ...settings,
        providerProfiles: {
          ...settings.providerProfiles,
          [providerId]: structuredClone(defaultWebProviderProfiles[providerId]),
        },
      },
    });
  };

  const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleHistoryOutcome = async (
    intent: WebWorkbenchHistoryAction,
  ): Promise<void> => {
    const outcome = await workbench.dispatch(intent);
    if (outcome?.status !== 'effect') return;
    if (outcome.effect === 'download-history-artifact') {
      if (
        outcome.artifact.kind === 'results'
        && outcome.artifact.omissions.length > 0
        && !window.confirm(
          `有 ${outcome.artifact.omissions.length} 个结果缺失或损坏，将只导出其余 `
          + `${outcome.artifact.exportedCount} 个结果。是否继续？`,
        )
      ) {
        return;
      }
      downloadBlob(outcome.artifact.blob, outcome.artifact.fileName);
    }
    if (outcome.effect === 'open-workbench') {
      setActiveView('workbench');
      setPreviewMode('original');
      if (outcome.providerSelectionRequired) {
        setProviderDetailsOpen(true);
      }
    }
  };

  const exportHistoryProject = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyExportWarning)) return;
    await handleHistoryOutcome({ type: 'export-history-project', batchId });
  };

  const keepHistoryResultsOnly = async (batchId: string): Promise<void> => {
    if (!window.confirm(copy.historyKeepResultsWarning)) return;
    await handleHistoryOutcome({ type: 'keep-history-results', batchId });
  };

  const removeImage = async (id: string): Promise<void> => {
    await workbench.dispatch({ type: 'remove-image', imageId: id });
  };

  const moveImage = async (id: string, direction: -1 | 1): Promise<void> => {
    await workbench.dispatch({ type: 'move-image', imageId: id, direction });
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
    void workbench.dispatch({ type: 'install-models' }).catch(() => undefined);
  };

  const cancelCurrent = (): void => {
    if (!processing.canCancelCurrent) return;
    void workbench.dispatch({ type: 'cancel-current' }).catch(() => undefined);
  };

  const stopBatch = (): void => {
    if (!processing.canStop) return;
    void workbench.dispatch({ type: 'stop-processing' }).catch(() => undefined);
  };

  const retryTask = (taskId: string): void => {
    if (!processing.canRetryTasks) return;
    void workbench.dispatch({ type: 'retry-task', taskId }).catch(() => undefined);
  };

  const exitHistoryResume = (): void => {
    if (batchRunning) return;
    void workbench.dispatch({ type: 'exit-recovery' }).catch(() => undefined);
  };

  const startBatch = async (): Promise<void> => {
    if (queueRuntimeDecision.status !== 'available') return;
    await workbench.dispatch({ type: 'start-processing' }).catch(() => undefined);
  };

  const startAllowed = (
    primaryAction.kind === 'start-processing'
    && primaryAction.availability.status === 'available'
  );
  const continuousCameraAllowed = cameraEntry.kind === 'open-camera'
    && cameraEntry.availability.status === 'available';
  const continuousCameraBlocker = cameraEntry.kind === 'open-provider-settings'
    ? providerConfigurationError ?? copy.startUnavailable
    : storageImportIssue ?? runtimeBlockerMessage(cameraEntry.availability);

  const handleContinuousCameraEntry = (): void => {
    void workbench.dispatch({ type: 'activate-camera-entry' }).then((outcome) => {
      if (outcome?.status !== 'effect') return;
      if (outcome.effect === 'open-storage-settings') {
        setActiveView('settings');
        void refreshStorage();
      } else if (outcome.effect === 'open-provider-settings') {
        setProviderDetailsOpen(true);
        setMobilePane('settings');
      }
    }).catch(() => undefined);
  };

  const continueContinuousCamera = (): void => {
    void workbench.dispatch({ type: 'next-camera' });
  };

  const closeContinuousCamera = (): void => {
    void workbench.dispatch({ type: 'close-camera' }).catch(() => undefined);
  };

  const translateContinuousCameraCapture = async (file: File): Promise<void> => {
    await workbench.dispatch({ type: 'capture-camera', file });
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
          && controls.importImages.status === 'available'
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
    controls.importImages.status,
    startAllowed,
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
    && queueRuntimeDecision.reason === 'CAPABILITY_FAILED'
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
    ? queueRuntimeDecision.reason
    : undefined;
  const modelProbeRetryAvailable = (
    queueRuntimeBlockerCode === 'MODEL_PROBE_FAILED'
    || queueRuntimeBlockerCode === 'CAPABILITY_FAILED'
  );
  const primaryActionLabel = primaryAction.kind === 'stop-processing'
    ? copy.stopBatch
    : primaryAction.kind === 'pick-images'
      ? copy.addImages
      : primaryAction.kind === 'open-storage-settings'
        ? copy.settings
        : primaryAction.kind === 'install-models'
          ? !modelConsent
            ? copy.modelConsent
            : modelPackageState.status === 'paused'
              ? copy.modelResume
              : copy.modelRetry
          : primaryAction.kind === 'retry-runtime'
            ? copy.modelProbeRetry
            : primaryAction.kind === 'open-provider-settings'
              ? copy.openProviderSettings
              : copy.start;
  const primaryActionIconName: IconName = primaryAction.kind === 'stop-processing'
    ? 'stop'
    : primaryAction.kind === 'pick-images'
      ? 'add'
      : primaryAction.kind === 'open-storage-settings'
        || primaryAction.kind === 'open-provider-settings'
        ? 'gear'
        : primaryAction.kind === 'install-models'
          ? 'download'
          : primaryAction.kind === 'retry-runtime'
            ? 'refresh'
            : 'play';
  const primaryActionDisabled = primaryAction.availability.status === 'blocked';
  const handlePrimaryAction = (): void => {
    void workbench.dispatch({ type: 'activate-primary' }).then((outcome) => {
      if (outcome?.status !== 'effect') return;
      if (outcome.effect === 'pick-images') {
        fileInputRef.current?.click();
      } else if (outcome.effect === 'open-storage-settings') {
        setActiveView('settings');
        void refreshStorage();
      } else {
        setProviderDetailsOpen(true);
        setMobilePane('settings');
      }
    }).catch(() => undefined);
  };
  const visiblePreviewUrl = (
    previewMode === 'result' && selectedJob?.resultUrl
      ? selectedJob.resultUrl
      : selectedPreviewUrl
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
              void workbench.dispatch({ type: 'refresh-history' });
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
                void workbench.dispatch({ type: 'refresh-history' });
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
              disabled={controls.importImages.status === 'blocked'}
              onChange={handleFileInput}
            />
            <div className="import-actions">
              <button
                className="button button-secondary button-compact camera-action"
                type="button"
                title={continuousCameraAllowed
                  ? copy.continuousCamera
                  : continuousCameraBlocker}
                disabled={cameraEntry.availability.status === 'blocked'}
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
                disabled={controls.importImages.status === 'blocked'}
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
                disabled={controls.importImages.status === 'blocked'}
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
                const actions = itemActions[image.id];
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
                        void workbench.dispatch({ type: 'select-image', imageId: image.id });
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
                          disabled={actions?.retry.status === 'blocked'}
                          onClick={() => retryTask(image.id)}
                        >
                          <Icon name="refresh" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={actions?.moveUp.status === 'blocked'}
                        aria-label={copy.moveUp}
                        title={copy.moveUp}
                        onClick={() => void moveImage(image.id, -1)}
                      >
                        <Icon name="arrow-up" />
                      </button>
                      <button
                        type="button"
                        disabled={actions?.moveDown.status === 'blocked'}
                        aria-label={copy.moveDown}
                        title={copy.moveDown}
                        onClick={() => void moveImage(image.id, 1)}
                      >
                        <Icon name="arrow-down" />
                      </button>
                      <button
                        type="button"
                        disabled={actions?.remove.status === 'blocked'}
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
                <button
                  type="button"
                  onClick={() => void workbench.dispatch({ type: 'clear-rejections' })}
                >
                  {copy.clearIssues}
                </button>
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
                  disabled={cameraEntry.availability.status === 'blocked'}
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
                    disabled={!processingSettingsEditable}
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
                  disabled={!processingSettingsEditable}
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
                    !processingSettingsEditable
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
                          disabled={!processingSettingsEditable}
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
                          disabled={!processingSettingsEditable}
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
                          !processingSettingsEditable
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
                            !processingSettingsEditable
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
                        disabled={!processingSettingsEditable}
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
                          void workbench.dispatch({ type: 'retry-runtime' });
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
                            void workbench.dispatch({ type: 'cancel-model-install' });
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
                    disabled={!processing.canCancelCurrent}
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
            {recoveryActive && !batchRunning && (
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
            (historyAction?.status === 'rejected'
              ? historyRejectionMessage(historyAction.code, settings.uiLocale)
              : historyAction?.status === 'failed'
                ? `${historyAction.operation}: ${historyAction.cause}`
                : undefined)
            ?? historyCleanupFaultMessage
            ?? (historySnapshot.failure
              ? `${historySnapshot.failure.operation}: ${historySnapshot.failure.cause}`
              : undefined)
          }
          onRefresh={() => void handleHistoryOutcome({ type: 'refresh-history' })}
          onResume={(batchId) => void handleHistoryOutcome({
            type: 'resume-history',
            batchId,
          })}
          onClone={(batchId) => void handleHistoryOutcome({
            type: 'clone-history',
            batchId,
          })}
          onDownload={(batchId, itemId) => void handleHistoryOutcome({
            type: 'download-history-result',
            batchId,
            itemId,
          })}
          onExportResults={(batchId) => void handleHistoryOutcome({
            type: 'export-history-results',
            batchId,
          })}
          onExportProject={(batchId) => void exportHistoryProject(batchId)}
          onImportProject={(file) => void handleHistoryOutcome({
            type: 'import-history-project',
            file,
          })}
          onKeepResults={(batchId) => void keepHistoryResultsOnly(batchId)}
          onDelete={(batchId) => void handleHistoryOutcome({
            type: 'stage-history-delete',
            batchId,
          })}
        />
      ) : (
        <SettingsView
          copy={copy}
          settings={settings}
          historyLocked={recoveryActive}
          storageSnapshot={storageSnapshot}
          storageChecking={storageChecking}
          diagnosticBusy={diagnosticState.exporting}
          onLocaleChange={(locale) => patchSettings({ uiLocale: locale })}
          onRefreshStorage={() => {
            void refreshStorage();
          }}
          onManageHistory={() => {
            setActiveView('history');
            void workbench.dispatch({ type: 'refresh-history' });
          }}
          onExportDiagnostics={() => {
            void workbench.dispatch({ type: 'export-diagnostics' }).catch(() => undefined);
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
            onClick={() => void handleHistoryOutcome({ type: 'undo-history-action' })}
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
