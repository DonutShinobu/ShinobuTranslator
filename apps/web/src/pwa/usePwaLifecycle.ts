import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

export type PwaLifecycle = {
  online: boolean;
  updateReady: boolean;
  offlineReady: boolean;
  activateUpdate(): void;
};

export function usePwaLifecycle(): PwaLifecycle {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const activatingRef = useRef(false);

  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return undefined;
    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;

    const inspectInstallingWorker = (): void => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (
          !disposed
          && worker.state === 'installed'
          && navigator.serviceWorker.controller
        ) {
          setUpdateReady(true);
        }
      });
    };
    const handleMessage = (event: MessageEvent): void => {
      if (event.data?.type === 'PWA_UPDATE_READY') setUpdateReady(true);
      if (event.data?.type === 'PWA_OFFLINE_READY') setOfflineReady(true);
    };
    const handleControllerChange = (): void => {
      if (activatingRef.current) window.location.reload();
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((value) => {
        if (disposed) return;
        registration = value;
        registrationRef.current = value;
        if (value.waiting) setUpdateReady(true);
        value.addEventListener('updatefound', inspectInstallingWorker);
        if (navigator.serviceWorker.controller) setOfflineReady(true);
      })
      .catch(() => {
        // PWA support is progressive; the Web workbench remains available.
      });

    return () => {
      disposed = true;
      registration?.removeEventListener('updatefound', inspectInstallingWorker);
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  const activateUpdate = useCallback((): void => {
    const waiting = registrationRef.current?.waiting;
    if (!waiting) return;
    activatingRef.current = true;
    waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  }, []);

  return {
    online,
    updateReady,
    offlineReady,
    activateUpdate,
  };
}
