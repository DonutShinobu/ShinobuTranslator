export type PerfTraceWorkerCall = {
  kind: string;
  model?: string;
  provider?: string;
  inputBytes?: number;
  outputBytes?: number;
  startedAt: number;
  durationMs: number;
  error?: string;
};

export type PerfTraceRuntimeEvent = {
  kind:
    | 'worker-bootstrap-attempt'
    | 'worker-bootstrap-complete'
    | 'session-create-start'
    | 'session-create-complete'
    | 'session-cache-hit'
    | 'provider-fallback'
    | 'inference-failure';
  model?: string;
  provider?: string;
  message: string;
  data?: Record<string, unknown>;
  error?: unknown;
};

export type PerfTraceSink = {
  recordWorkerCall(call: PerfTraceWorkerCall): void;
  recordRuntimeEvent?(event: PerfTraceRuntimeEvent): void;
};

const activeSinks = new Set<PerfTraceSink>();

export function setPerfTraceSink(sink: PerfTraceSink | null): () => void {
  if (!sink) {
    return () => undefined;
  }
  activeSinks.add(sink);
  return () => {
    activeSinks.delete(sink);
  };
}

export function recordPerfWorkerCall(call: PerfTraceWorkerCall): void {
  for (const sink of activeSinks) {
    sink.recordWorkerCall(call);
  }
}

export function recordPerfRuntimeEvent(event: PerfTraceRuntimeEvent): void {
  for (const sink of activeSinks) {
    sink.recordRuntimeEvent?.(event);
  }
}
