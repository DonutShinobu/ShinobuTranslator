type BarrierAware = {
  setConformanceBarrierSink?(sink: (barrier: string) => void): void;
};

type TraceOptions = {
  executionOrdinal: number;
  jobId: string;
  providerExecution: BarrierAware;
  translationTransport: BarrierAware;
  post(message: {
    type: 'progress';
    jobId: string;
    progress: {
      stage: string;
      operation: string;
      detail: string;
    };
  }): Promise<boolean>;
};

async function report(options: TraceOptions, operation: string): Promise<void> {
  if (!await options.post({
    type: 'progress',
    jobId: options.jobId,
    progress: {
      stage: 'semantic-trace',
      operation,
      detail: operation,
    },
  })) {
    throw new Error(`Semantic trace event was not delivered: ${operation}`);
  }
}

export function createPipelineHostExecutionTrace(options: TraceOptions) {
  const pendingEvents: string[] = [];
  const sink = (barrier: string): void => {
    pendingEvents.push(barrier);
  };
  options.providerExecution.setConformanceBarrierSink?.(sink);
  options.translationTransport.setConformanceBarrierSink?.(sink);

  return {
    async recordFinalization(): Promise<void> {
      for (const event of pendingEvents.splice(0)) {
        await report(options, event);
      }
      await report(options, 'execution-finalized');
    },
    async recordResourceSettlement(): Promise<void> {
      pendingEvents.push('runtime-resources-settled');
    },
    async afterArtifactChunk(): Promise<void> {},
    dispose(): void {
      options.providerExecution.setConformanceBarrierSink?.(() => undefined);
      options.translationTransport.setConformanceBarrierSink?.(() => undefined);
    },
  };
}
