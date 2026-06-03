export type PerfTraceWorkerCall = {
  kind: string;
  model?: string;
  provider?: string;
  inputBytes?: number;
  outputBytes?: number;
  startedAt: number;
  durationMs: number;
};

export type PerfTraceSink = {
  recordWorkerCall(call: PerfTraceWorkerCall): void;
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
