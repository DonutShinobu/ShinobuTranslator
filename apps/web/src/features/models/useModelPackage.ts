import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  WEB_MODEL_PACKAGE,
  WEB_MODEL_PACKAGE_SIZE,
} from '../../runtime/modelPackage';
import {
  ensureModelStorageCapacity,
  inspectModelPackage,
  installModelPackage,
  type ModelInstallProgress,
} from '../../runtime/modelInstaller';
import { OpfsModelPackageStore } from '../../runtime/modelPackageStore';

export type ModelPackageStatus =
  | 'checking'
  | 'missing'
  | 'installing'
  | 'paused'
  | 'failed'
  | 'installed';

export type ModelPackageState = {
  status: ModelPackageStatus;
  progress?: ModelInstallProgress;
  storedBytes: number;
  totalBytes: number;
  error?: string;
};

type AbortKind = 'cancelled' | 'hidden';

export function useModelPackage(): {
  state: ModelPackageState;
  install(): Promise<void>;
  cancel(): void;
} {
  const storeRef = useRef(new OpfsModelPackageStore());
  const controllerRef = useRef<AbortController | null>(null);
  const abortKindRef = useRef<AbortKind | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<ModelPackageState>({
    status: 'checking',
    storedBytes: 0,
    totalBytes: WEB_MODEL_PACKAGE_SIZE,
  });

  useEffect(() => {
    mountedRef.current = true;
    void inspectModelPackage(storeRef.current, WEB_MODEL_PACKAGE)
      .then((inspection) => {
        if (!mountedRef.current) return;
        setState({
          status: inspection.installed ? 'installed' : 'missing',
          storedBytes: inspection.storedBytes,
          totalBytes: inspection.totalBytes,
        });
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setState({
          status: 'failed',
          storedBytes: 0,
          totalBytes: WEB_MODEL_PACKAGE_SIZE,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort(new DOMException('页面已关闭', 'AbortError'));
    };
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    abortKindRef.current = null;
    setState((current) => ({
      ...current,
      status: 'installing',
      error: undefined,
    }));
    try {
      const before = await inspectModelPackage(storeRef.current, WEB_MODEL_PACKAGE);
      if (before.installed) {
        setState({
          status: 'installed',
          storedBytes: before.totalBytes,
          totalBytes: before.totalBytes,
        });
        return;
      }
      if (before.storedBytes === 0) {
        await ensureModelStorageCapacity();
      }
      await installModelPackage({
        manifest: WEB_MODEL_PACKAGE,
        store: storeRef.current,
        signal: controller.signal,
        onProgress(progress) {
          if (!mountedRef.current) return;
          setState({
            status: 'installing',
            progress,
            storedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
        },
      });
      if (!mountedRef.current) return;
      setState({
        status: 'installed',
        storedBytes: WEB_MODEL_PACKAGE_SIZE,
        totalBytes: WEB_MODEL_PACKAGE_SIZE,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      const inspection = await inspectModelPackage(
        storeRef.current,
        WEB_MODEL_PACKAGE,
      ).catch(() => ({
        installed: false,
        storedBytes: 0,
        totalBytes: WEB_MODEL_PACKAGE_SIZE,
      }));
      if (!mountedRef.current) return;
      if (controller.signal.aborted) {
        setState({
          status: abortKindRef.current === 'hidden' ? 'paused' : 'missing',
          storedBytes: inspection.storedBytes,
          totalBytes: inspection.totalBytes,
        });
      } else {
        setState({
          status: 'failed',
          storedBytes: inspection.storedBytes,
          totalBytes: inspection.totalBytes,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      abortKindRef.current = null;
    }
  }, []);

  const cancel = useCallback((): void => {
    abortKindRef.current = 'cancelled';
    controllerRef.current?.abort(new DOMException('模型下载已取消', 'AbortError'));
  }, []);

  useEffect(() => {
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'hidden' || !controllerRef.current) return;
      abortKindRef.current = 'hidden';
      controllerRef.current.abort(new DOMException('页面进入后台，模型下载已暂停', 'AbortError'));
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return { state, install, cancel };
}
