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
  LocalHistoryAsset,
  LocalHistoryBatch,
  LocalHistoryInspection,
} from './features/history/localHistory';
import {
  buildProjectPackage,
  buildResultsZip,
  validateProjectPackage,
} from './features/history/projectPackage';
import {
  createRedactedDiagnostics,
  downloadRedactedDiagnostics,
} from './features/diagnostics/redactedDiagnostics';
import { useLocalHistory } from './features/history/useLocalHistory';
import { decodeBrowserImage } from './features/import/browserImageDecoder';
import {
  createImageImporter,
  imageImportLimitsForDevice,
  type ImageImportRejection,
  type ImportedImage,
} from './features/import/imageImporter';
import { useModelPackage } from './features/models/useModelPackage';
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
import {
  IMAGE_IMPORT_STORAGE_HEADROOM_BYTES,
  assessImageImportStorage,
  formatByteSize as formatBytes,
  inspectWebStorage,
  type WebStorageSnapshot,
} from './features/storage/storageBudget';
import { usePwaLifecycle } from './pwa/usePwaLifecycle';
import { usePwaInstall } from './pwa/usePwaInstall';
import { WEB_MODEL_PACKAGE } from './runtime/modelPackage';
import {
  probeInstalledProductionModels,
  type ModelCapabilityProgress,
} from './runtime/modelCapability';
import {
  probeWebRuntimeCapability,
  type WebRuntimeCapability,
} from './runtime/capability';
import { detectWebDeviceProfile } from './runtime/deviceProfile';
import {
  createWebTranslatorCore,
  type WebTranslatorCore,
} from './runtime/webPipeline';

type MobilePane = 'queue' | 'preview' | 'settings';
type PreviewMode = 'original' | 'result';
type PreviewScale = 'fit' | number;
type ActiveView = 'workbench' | 'history' | 'settings';
type ModelRuntimeProbeState = {
  status: 'pending' | 'checking' | 'ready' | 'failed';
  progress?: ModelCapabilityProgress;
  provider?: 'webgpu' | 'wasm';
  error?: string;
};

const processModes: ReadonlyArray<ProcessMode> = ['translate', 'original', 'erase'];
const previewZoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MODEL_CONSENT_STORAGE_KEY = 'shinobu:model-download-consent:v1';
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

function readModelConsent(): boolean {
  try {
    return localStorage.getItem(MODEL_CONSENT_STORAGE_KEY) === 'accepted';
  } catch {
    return false;
  }
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
  const [historyBusy, setHistoryBusy] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [storageSnapshot, setStorageSnapshot] = useState<WebStorageSnapshot | null>(null);
  const [storageChecking, setStorageChecking] = useState(true);
  const [storageImportError, setStorageImportError] = useState<string>();
  const [pendingHistoryDeleteId, setPendingHistoryDeleteId] = useState<string>();
  const [resumeHistoryBatchId, setResumeHistoryBatchId] = useState<string>();
  const [modelConsent, setModelConsent] = useState(readModelConsent);
  const [capability, setCapability] = useState<WebRuntimeCapability | null>(null);
  const [modelRuntimeProbe, setModelRuntimeProbe] = useState<ModelRuntimeProbeState>({
    status: 'pending',
  });
  const [modelProbeAttempt, setModelProbeAttempt] = useState(0);
  const [capabilityProbeAttempt, setCapabilityProbeAttempt] = useState(0);
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
  const activeImportPromiseRef = useRef<Promise<void> | null>(null);
  const historyDeleteTimerRef = useRef<number>();
  const translatorCoreRef = useRef<WebTranslatorCore | null>(null);
  const runtimeRefreshPendingRef = useRef(false);
  const continuousCameraRoundIdRef = useRef(0);
  const continuousCameraCaptureActiveRef = useRef(false);
  const continuousCameraUrlsRef = useRef<Set<string>>(new Set());
  const modelPackage = useModelPackage();
  const providerSecrets = useProviderSecrets(settings.providerProfiles);
  const localHistory = useLocalHistory();
  const pwa = usePwaLifecycle();
  const pwaInstall = usePwaInstall();

  const copy = getCopy(settings.uiLocale);
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
    setStorageChecking(true);
    const snapshot = await inspectWebStorage();
    setStorageSnapshot(snapshot);
    setStorageChecking(false);
    return snapshot;
  }, []);
  const processingWorkspace = useMemo(
    () => createProcessingBatchWorkspace({
      history: localHistory.history,
      getCore: () => {
        const core = translatorCoreRef.current ?? createWebTranslatorCore();
        translatorCoreRef.current = core;
        return core;
      },
      storage: {
        async admit(pendingOriginalBytes) {
          const assessment = assessImageImportStorage(
            await inspectWebStorage(),
            pendingOriginalBytes,
          );
          if (assessment.allowed) return;
          if (assessment.reason === 'unavailable') {
            throw new Error('浏览器无法确认本地存储空间');
          }
          throw new Error(
            `本地存储空间不足：需要 ${formatBytes(assessment.requiredBytes)}，`
            + `当前可用 ${formatBytes(assessment.availableBytes ?? 0)}`,
          );
        },
      },
      async readThumbnail(image) {
        try {
          const response = await fetch(image.thumbnailUrl);
          return response.ok ? await response.blob() : undefined;
        } catch {
          return undefined;
        }
      },
    }),
    [localHistory.history],
  );

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const refreshRuntimeCapability = useCallback((): void => {
    runtimeRefreshPendingRef.current = false;
    translatorCoreRef.current?.dispose(
      new DOMException('页面恢复，正在重建本地推理环境', 'AbortError'),
    );
    translatorCoreRef.current = null;
    setModelRuntimeProbe({ status: 'pending' });
    setCapability(null);
    setCapabilityProbeAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        runtimeRefreshPendingRef.current = true;
        const activeBatch = activeProcessingBatchRef.current;
        if (activeBatch?.snapshot().status === 'running') {
          void activeBatch.dispatch({ type: 'stop' }).catch(() => undefined);
        }
        return;
      }
      const activeSnapshot = activeProcessingBatchRef.current?.snapshot();
      if (
        document.visibilityState === 'visible'
        && runtimeRefreshPendingRef.current
        && !activeSnapshot?.currentTaskId
        && !batchRunningRef.current
      ) {
        refreshRuntimeCapability();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshRuntimeCapability]);

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
    translatorCoreRef.current?.dispose();
  }, []);

  useEffect(() => () => {
    if (historyDeleteTimerRef.current !== undefined) {
      clearTimeout(historyDeleteTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!pwa.online) {
      setCapability({
        ok: false,
        reason: copy.offlineHistoryOnly,
        supportLevel: deviceProfile.supportLevel,
        backend: 'wasm',
        workPixelBudget: deviceProfile.initialWorkPixelBudget,
        storagePersistent: false,
        wasmThreads: false,
        webgpu: false,
      });
      return undefined;
    }
    let active = true;
    void probeWebRuntimeCapability(WEB_MODEL_PACKAGE.version, {
      useCache: capabilityProbeAttempt === 0,
    }).then((result) => {
      if (active) setCapability(result);
    });
    return () => {
      active = false;
    };
  }, [capabilityProbeAttempt, copy.offlineHistoryOnly, deviceProfile, pwa.online]);

  useEffect(() => {
    if (modelPackage.state.status !== 'installed' || capability?.ok !== true) {
      setModelRuntimeProbe({ status: 'pending' });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setModelRuntimeProbe({ status: 'checking' });
    void probeInstalledProductionModels({
      backend: capability.backend,
      signal: controller.signal,
      onProgress(progress) {
        if (active) setModelRuntimeProbe({ status: 'checking', progress });
      },
    }).then((result) => {
      if (!active) return;
      if (
        result.ok
        && result.provider === 'wasm'
        && capability.backend === 'webgpu'
      ) {
        setModelRuntimeProbe({ status: 'checking', provider: 'wasm' });
        setCapability((current) => current?.ok
          ? {
            ...current,
            backend: 'wasm',
            workPixelBudget: Math.min(
              current.workPixelBudget,
              deviceProfile.mobile ? 4_000_000 : 6_000_000,
            ),
          }
          : current);
        return;
      }
      setModelRuntimeProbe(result.ok
        ? { status: 'ready', provider: result.provider }
        : { status: 'failed', error: result.error });
    });
    return () => {
      active = false;
      controller.abort(new DOMException('能力测试已取消', 'AbortError'));
    };
  }, [
    capability?.backend,
    capability?.ok,
    deviceProfile.mobile,
    modelPackage.state.status,
    modelProbeAttempt,
  ]);

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
        void localHistory.refresh();
        void refreshStorage();
        if (snapshot.tasks.some((task) => task.status === 'done')) {
          pwaInstall.offerAfterSuccess();
        }
        if (
          runtimeRefreshPendingRef.current
          && document.visibilityState === 'visible'
        ) {
          refreshRuntimeCapability();
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
    setSettings((current) => ({ ...current, ...patch }));
  };

  const patchActiveProviderProfile = (
    patch: Partial<WebSettings['providerProfiles'][TranslationProviderId]>,
  ): void => {
    if (batchRunningRef.current || resumeHistoryBatchId) return;
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

  const downloadHistoryAsset = async (reference: LocalHistoryAsset): Promise<void> => {
    try {
      const blob = await localHistory.readAsset(reference);
      if (!blob) throw new Error('本地结果文件缺失或大小不一致');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = reference.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setHistoryActionError(undefined);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportHistoryResults = async (
    inspection: LocalHistoryInspection,
  ): Promise<void> => {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      const archive = await buildResultsZip(inspection, localHistory.readAsset);
      downloadBlob(
        archive,
        `${inspection.batch.createdAt.slice(0, 10)}-shinobu-results.zip`,
      );
      setHistoryActionError(undefined);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const exportHistoryProject = async (
    inspection: LocalHistoryInspection,
  ): Promise<void> => {
    if (historyBusy || !window.confirm(copy.historyExportWarning)) return;
    setHistoryBusy(true);
    try {
      const archive = await buildProjectPackage(inspection, localHistory.readAsset);
      downloadBlob(
        archive,
        `${inspection.batch.createdAt.slice(0, 10)}-${inspection.batch.id.slice(0, 8)}.shinobu.zip`,
      );
      setHistoryActionError(undefined);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const importHistoryProject = async (file: File): Promise<void> => {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      const validated = await validateProjectPackage(file);
      await localHistory.importBatch(validated.manifest.batch, validated.assets);
      void refreshStorage();
      setHistoryActionError(undefined);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const keepHistoryResultsOnly = async (batch: LocalHistoryBatch): Promise<void> => {
    if (
      historyBusy
      || resumeHistoryBatchId === batch.id
      || !window.confirm(copy.historyKeepResultsWarning)
    ) return;
    setHistoryBusy(true);
    try {
      await localHistory.keepResultsOnly(batch.id);
      void refreshStorage();
      setHistoryActionError(undefined);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const stageHistoryDelete = (batch: LocalHistoryBatch): void => {
    if (historyBusy || pendingHistoryDeleteId || resumeHistoryBatchId === batch.id) return;
    setPendingHistoryDeleteId(batch.id);
    historyDeleteTimerRef.current = window.setTimeout(() => {
      historyDeleteTimerRef.current = undefined;
      void localHistory.deleteBatch(batch.id)
        .then(() => refreshStorage())
        .catch((error) => {
          setHistoryActionError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setPendingHistoryDeleteId(undefined));
    }, 10_000);
  };

  const undoHistoryDelete = (): void => {
    if (historyDeleteTimerRef.current !== undefined) {
      clearTimeout(historyDeleteTimerRef.current);
      historyDeleteTimerRef.current = undefined;
    }
    setPendingHistoryDeleteId(undefined);
  };

  const cloneHistoryBatch = async (batch: LocalHistoryBatch): Promise<void> => {
    if (
      !batch.rerunnable
      || batchRunningRef.current
      || activeProcessingBatchRef.current
      || resumeHistoryBatchId
    ) return;
    try {
      const files: File[] = [];
      for (const item of [...batch.items].sort((left, right) => left.order - right.order)) {
        if (!item.original) throw new Error('此记录未保留原图，不能克隆');
        const blob = await localHistory.readAsset(item.original);
        if (!blob) throw new Error(`原图缺失或损坏: ${item.original.fileName}`);
        files.push(new File([blob], item.original.fileName, {
          type: item.original.mediaType,
          lastModified: new Date(batch.createdAt).getTime(),
        }));
      }
      const imported = await importer.importFiles(files, []);
      if (imported.accepted.length !== files.length) {
        throw new Error('历史原图未能全部通过当前版本的导入校验');
      }

      for (const { id } of translationProviderOptions) {
        let changed = true;
        try {
          changed = normalizeProviderTargetBinding(batch.settings.providerProfiles[id].baseUrl)
            !== normalizeProviderTargetBinding(settings.providerProfiles[id].baseUrl);
        } catch {
          // Invalid legacy targets must never retain a current provider secret.
        }
        if (changed) {
          providerSecrets.invalidateTarget(id);
        }
      }

      queueRef.current.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
      Object.values(jobsRef.current).forEach((job) => {
        if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
      });
      queueRef.current = imported.accepted;
      jobsRef.current = {};
      setQueue(imported.accepted);
      setJobs({});
      setSelectedId(imported.accepted[0]?.id ?? null);
      setPreviewMode('original');
      setSettings(structuredClone(batch.settings));
      resumeHistoryBatchRef.current = null;
      setResumeHistoryBatchId(undefined);
      setRejections([]);
      setBatchNotice('');
      setHistoryActionError(undefined);
      setActiveView('workbench');
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const resumeHistoryBatch = async (batch: LocalHistoryBatch): Promise<void> => {
    if (
      !batch.rerunnable
      || batchRunningRef.current
      || activeProcessingBatchRef.current
      || resumeHistoryBatchId
      || historyBusy
    ) return;
    setHistoryBusy(true);
    try {
      const orderedItems = [...batch.items].sort((left, right) => left.order - right.order);
      const files: File[] = [];
      for (const item of orderedItems) {
        if (!item.original) throw new Error('恢复批次缺少原图');
        const blob = await localHistory.readAsset(item.original);
        if (!blob) throw new Error(`原图缺失或损坏: ${item.original.fileName}`);
        files.push(new File([blob], item.original.fileName, {
          type: item.original.mediaType,
          lastModified: new Date(batch.createdAt).getTime(),
        }));
      }
      const imported = await importer.importFiles(files, []);
      if (imported.accepted.length !== orderedItems.length) {
        throw new Error('历史原图未能全部通过当前版本的导入校验');
      }

      const restoredImages = imported.accepted.map((image, index) => ({
        ...image,
        id: orderedItems[index].id,
      }));
      const restoredJobs: Record<string, QueueJobState> = {};
      for (const item of orderedItems) {
        if (item.status === 'done') {
          restoredJobs[item.id] = {
            status: 'done',
            progress: { stage: 'done', detail: '已从恢复点载入' },
          };
        } else {
          restoredJobs[item.id] = {
            status: item.status === 'running' ? 'queued' : item.status,
            error: item.error,
          };
        }
      }

      for (const { id } of translationProviderOptions) {
        let changed = true;
        try {
          changed = normalizeProviderTargetBinding(batch.settings.providerProfiles[id].baseUrl)
            !== normalizeProviderTargetBinding(settings.providerProfiles[id].baseUrl);
        } catch {
          // Invalid legacy targets must never retain a current provider secret.
        }
        if (changed) {
          providerSecrets.invalidateTarget(id);
        }
      }

      queueRef.current.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
      Object.values(jobsRef.current).forEach((job) => {
        if (job.resultUrl) URL.revokeObjectURL(job.resultUrl);
      });
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
      setSettings(structuredClone(batch.settings));
      resumeHistoryBatchRef.current = batch;
      setResumeHistoryBatchId(batch.id);
      setRejections([]);
      setBatchNotice(copy.historyResumeReady);
      setHistoryActionError(undefined);
      setActiveView('workbench');
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
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
    try {
      localStorage.setItem(MODEL_CONSENT_STORAGE_KEY, 'accepted');
    } catch {
      // Consent still applies to the current session when storage is blocked.
    }
    setModelConsent(true);
    void modelPackage.install();
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
    resumeHistoryBatchRef.current = null;
    setResumeHistoryBatchId(undefined);
    setBatchNotice('');
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
      || capability?.ok !== true
      || modelPackage.state.status !== 'installed'
      || !providerReady
      || !pwa.online
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
      const credential = {
        providerId: settings.translationProviderId,
        target: activeProviderProfile.baseUrl,
        value: activeProviderKey,
      };
      let processingBatch: ProcessingBatch;
      if (resumedBatchId) {
        const source = resumeHistoryBatchRef.current;
        if (!source || source.id !== resumedBatchId) {
          throw new Error('恢复处理批次的本地历史上下文已失效');
        }
        processingBatch = await processingWorkspace.resume({
          batch: source,
          images: queueRef.current,
          inputLifetime: 'until-closed',
          credential,
        });
        resumeHistoryBatchRef.current = null;
      } else {
        processingBatch = await processingWorkspace.open({
          kind: 'queue',
          inputLifetime: 'until-closed',
          initialImages: queueRef.current,
          settings,
          versions: LOCAL_HISTORY_VERSIONS,
          credential,
        });
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
        modelPackage: modelPackage.state,
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
    && capability?.ok === true
    && modelPackage.state.status === 'installed'
    && modelRuntimeProbe.status === 'ready'
    && providerReady
    && pwa.online
  );
  const continuousCameraAllowed = (
    !batchRunning
    && !importing
    && !activeImportPromiseRef.current
    && capability?.ok === true
    && modelPackage.state.status === 'installed'
    && modelRuntimeProbe.status === 'ready'
    && providerReady
    && pwa.online
    && !storageHardBlocked
    && !resumeHistoryBatchId
  );
  const continuousCameraBlocker = storageImportIssue
    ?? (!pwa.online
      ? copy.offlineHistoryOnly
      : capability === null
        ? copy.modelGateChecking
        : capability.ok !== true
          ? capability.reason
          : modelPackage.state.status !== 'installed'
            || modelRuntimeProbe.status !== 'ready'
            ? copy.modelGatePending
            : providerValidationError ?? copy.startUnavailable);

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
        credential: {
          providerId: settings.translationProviderId,
          target: activeProviderProfile.baseUrl,
          value: activeProviderKey,
        },
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
      (modelPackage.state.storedBytes / Math.max(1, modelPackage.state.totalBytes)) * 100,
    ),
  );
  const modelGateState = modelPackage.state.status === 'installed'
    ? modelRuntimeProbe.status === 'ready'
      ? 'ready'
      : modelRuntimeProbe.status === 'failed'
        ? 'error'
        : 'pending'
    : modelPackage.state.status === 'failed'
      ? 'error'
      : 'pending';
  const modelGateDetail = modelPackage.state.status === 'checking'
    ? copy.modelGateChecking
    : modelPackage.state.status === 'installed'
      ? modelRuntimeProbe.status === 'ready'
        ? copy.modelGateReady
        : modelRuntimeProbe.status === 'failed'
          ? copy.modelGateProbeFailed
          : copy.modelGateProbing(
            modelRuntimeProbe.progress?.modelId ?? 'runtime',
            modelRuntimeProbe.progress?.completed ?? 0,
            modelRuntimeProbe.progress?.total ?? 4,
          )
      : modelPackage.state.status === 'installing'
        ? modelPackage.state.progress?.phase === 'verifying'
          ? copy.modelGateVerifying
          : copy.modelGateInstalling
        : modelPackage.state.status === 'paused'
          ? copy.modelGatePaused
      : modelPackage.state.status === 'failed'
            ? copy.modelGateFailed
            : copy.modelGatePending;
  const startBlockerDetail = queue.length === 0
    ? copy.queueRequired
    : storageImportIssue
      ?? (!pwa.online
        ? copy.offlineHistoryOnly
        : capability === null
          ? copy.modelGateChecking
          : capability.ok !== true
            ? capability.reason
            : modelPackage.state.status !== 'installed'
              || modelRuntimeProbe.status !== 'ready'
              ? modelGateDetail
              : providerValidationError ?? copy.startUnavailable);
  const modelInstallActionAvailable = (
    pwa.online
    && capability?.ok === true
    && modelPackage.state.status !== 'installed'
    && modelPackage.state.status !== 'checking'
    && modelPackage.state.status !== 'installing'
  );
  const modelProbeRetryAvailable = (
    modelPackage.state.status === 'installed'
    && modelRuntimeProbe.status === 'failed'
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
              : modelPackage.state.status === 'paused'
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
      setModelProbeAttempt((current) => current + 1);
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
            disabled={batchRunning}
            onClick={() => {
              setActiveView('history');
              setHistoryActionError(undefined);
              void localHistory.refresh();
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
              disabled={batchRunning && activeView !== 'history'}
              onClick={() => {
                setActiveView('history');
                setHistoryActionError(undefined);
                void localHistory.refresh();
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
                  {modelRuntimeProbe.status === 'failed' && (
                    <>
                      {modelRuntimeProbe.error && (
                        <small className="model-error" role="alert">
                          {modelRuntimeProbe.error}
                        </small>
                      )}
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => setModelProbeAttempt((current) => current + 1)}
                      >
                        {copy.modelProbeRetry}
                      </button>
                    </>
                  )}
                  {modelPackage.state.status !== 'installed' && (
                    <>
                      {modelPackage.state.storedBytes > 0 && (
                        <small>
                          {copy.modelDownloadProgress(
                            modelProgressPercent,
                            formatBytes(modelPackage.state.storedBytes),
                            formatBytes(modelPackage.state.totalBytes),
                          )}
                        </small>
                      )}
                      {modelPackage.state.status === 'installing' && (
                        <progress
                          className="model-progress"
                          max={modelPackage.state.totalBytes}
                          value={modelPackage.state.storedBytes}
                          aria-label={copy.modelGateInstalling}
                        />
                      )}
                      {modelPackage.state.error && (
                        <small className="model-error" role="alert">
                          {modelPackage.state.error}
                        </small>
                      )}
                      {modelPackage.state.status === 'installing' ? (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={modelPackage.cancel}
                        >
                          {copy.modelCancel}
                        </button>
                      ) : modelPackage.state.status !== 'checking' && (
                        <button
                          className="inline-action"
                          type="button"
                          onClick={acceptModelDownload}
                        >
                          {!modelConsent
                            ? copy.modelConsent
                            : modelPackage.state.status === 'paused'
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
          entries={localHistory.entries.filter(
            (entry) => entry.batch.id !== pendingHistoryDeleteId,
          )}
          loading={localHistory.loading}
          busy={historyBusy || pendingHistoryDeleteId !== undefined}
          workbenchLocked={Boolean(resumeHistoryBatchId)}
          lockedBatchId={resumeHistoryBatchId}
          error={historyActionError ?? localHistory.error}
          onRefresh={() => void localHistory.refresh()}
          onResume={(batch) => void resumeHistoryBatch(batch)}
          onClone={(batch) => void cloneHistoryBatch(batch)}
          onDownload={(reference) => void downloadHistoryAsset(reference)}
          onExportResults={(inspection) => void exportHistoryResults(inspection)}
          onExportProject={(inspection) => void exportHistoryProject(inspection)}
          onImportProject={(file) => void importHistoryProject(file)}
          onKeepResults={(batch) => void keepHistoryResultsOnly(batch)}
          onDelete={stageHistoryDelete}
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
            if (batchRunningRef.current) return;
            setActiveView('history');
            setHistoryActionError(undefined);
            void localHistory.refresh();
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

      {pendingHistoryDeleteId && (
        <div className="undo-toast" role="status">
          <span>{copy.historyDeletePending}</span>
          <button type="button" onClick={undoHistoryDelete}>
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
