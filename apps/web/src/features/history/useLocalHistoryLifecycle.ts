import {
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  IndexedDbLocalHistoryIndexAdapter,
  OpfsLocalHistoryAssetAdapter,
} from './browserHistoryAdapters';
import { WebHistoryBatchCoordinator } from './historyCoordination';
import { LocalHistory } from './localHistory';
import {
  createLocalHistoryLifecycle,
  type LocalHistoryWorkbenchAdapter,
} from './localHistoryLifecycle';

export function useLocalHistoryLifecycle(workbench: LocalHistoryWorkbenchAdapter) {
  const environment = useMemo(() => {
    const history = new LocalHistory(
      new IndexedDbLocalHistoryIndexAdapter(),
      new OpfsLocalHistoryAssetAdapter(),
    );
    const coordinator = new WebHistoryBatchCoordinator();
    const lifecycle = createLocalHistoryLifecycle({
      history,
      coordinator,
      workbench,
    });
    return {
      history,
      coordinator,
      lifecycle,
    };
  }, [workbench]);
  const snapshot = useSyncExternalStore(
    environment.lifecycle.subscribe.bind(environment.lifecycle),
    environment.lifecycle.snapshot.bind(environment.lifecycle),
    environment.lifecycle.snapshot.bind(environment.lifecycle),
  );

  useEffect(() => {
    void environment.lifecycle.request({ type: 'retry-cleanup' });
    const refresh = (): void => {
      void environment.lifecycle.request({ type: 'retry-cleanup' });
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
      environment.lifecycle.dispose();
    };
  }, [environment]);

  return {
    ...environment,
    snapshot,
  };
}
