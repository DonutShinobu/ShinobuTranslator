import {
  useEffect,
  useRef,
  useState,
} from 'react';
import { createBrowserProcessingRuntime } from './browserProcessingRuntime';
import type {
  ProcessingRuntime,
  ProcessingRuntimeSnapshot,
} from './processingRuntime';

export type UseProcessingRuntime = {
  runtime: ProcessingRuntime;
  snapshot: ProcessingRuntimeSnapshot;
};

export function useProcessingRuntime(): UseProcessingRuntime {
  const runtimeRef = useRef<ProcessingRuntime>();
  if (!runtimeRef.current) runtimeRef.current = createBrowserProcessingRuntime();
  const runtime = runtimeRef.current;
  const [snapshot, setSnapshot] = useState(() => runtime.snapshot());
  const mountedRef = useRef(false);
  const refreshStartedRef = useRef(false);

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  useEffect(() => {
    mountedRef.current = true;
    if (!refreshStartedRef.current) {
      refreshStartedRef.current = true;
      void runtime.dispatch({ type: 'refresh' });
    }
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) void runtime.dispatch({ type: 'dispose' });
      });
    };
  }, [runtime]);

  return { runtime, snapshot };
}
