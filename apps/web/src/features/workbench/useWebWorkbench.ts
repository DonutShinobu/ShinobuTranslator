import { useEffect, useSyncExternalStore } from 'react';

import type { WebWorkbench, WebWorkbenchSnapshot } from './webWorkbench';

const pendingDisposals = new WeakMap<WebWorkbench, object>();

export function useWebWorkbench(workbench: WebWorkbench): WebWorkbenchSnapshot {
  const snapshot = useSyncExternalStore(
    workbench.subscribe,
    workbench.snapshot,
    workbench.snapshot,
  );

  useEffect(() => {
    pendingDisposals.delete(workbench);
    return () => {
      const token = {};
      pendingDisposals.set(workbench, token);
      queueMicrotask(() => {
        if (pendingDisposals.get(workbench) !== token) return;
        pendingDisposals.delete(workbench);
        void workbench.dispose();
      });
    };
  }, [workbench]);

  return snapshot;
}
