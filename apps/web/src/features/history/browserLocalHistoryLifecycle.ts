import {
  IndexedDbLocalHistoryIndexAdapter,
  OpfsLocalHistoryAssetAdapter,
} from './browserHistoryAdapters';
import { WebHistoryBatchCoordinator } from './historyCoordination';
import { LocalHistory } from './localHistory';
import {
  createLocalHistoryLifecycle,
  type LocalHistoryLifecycle,
  type LocalHistoryWorkbenchAdapter,
} from './localHistoryLifecycle';

export type BrowserLocalHistoryEnvironment = {
  history: LocalHistory;
  coordinator: WebHistoryBatchCoordinator;
  lifecycle: LocalHistoryLifecycle;
  dispose(): void;
};

export function createBrowserLocalHistoryEnvironment(
  workbench: LocalHistoryWorkbenchAdapter,
): BrowserLocalHistoryEnvironment {
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
  const retryCleanup = (): void => {
    void lifecycle.request({ type: 'retry-cleanup' });
  };
  const handleVisibility = (): void => {
    if (document.visibilityState === 'visible') retryCleanup();
  };
  retryCleanup();
  window.addEventListener('focus', retryCleanup);
  document.addEventListener('visibilitychange', handleVisibility);

  return {
    history,
    coordinator,
    lifecycle,
    dispose() {
      window.removeEventListener('focus', retryCleanup);
      document.removeEventListener('visibilitychange', handleVisibility);
      lifecycle.dispose();
    },
  };
}
