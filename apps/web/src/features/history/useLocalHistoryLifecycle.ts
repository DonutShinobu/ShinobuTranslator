import { useSyncExternalStore } from 'react';
import type { LocalHistoryLifecycle } from './localHistoryLifecycle';

export function useLocalHistoryLifecycle(lifecycle: LocalHistoryLifecycle) {
  return useSyncExternalStore(
    lifecycle.subscribe.bind(lifecycle),
    lifecycle.snapshot.bind(lifecycle),
    lifecycle.snapshot.bind(lifecycle),
  );
}
