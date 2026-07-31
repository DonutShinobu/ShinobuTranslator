import {
  createPipelineHostExecutionTrace as createSemanticTrace,
} from './pipelineHostExecutionTrace.semantic';

type TraceOptions = Parameters<typeof createSemanticTrace>[0];

export function createPipelineHostExecutionTrace(options: TraceOptions) {
  const trace = createSemanticTrace(options);
  return {
    ...trace,
    async afterArtifactChunk(
      artifact: 'result' | 'debug',
      index: number,
    ): Promise<void> {
      if (
        options.executionOrdinal !== 2
        || artifact !== 'result'
        || index !== 0
      ) return;
      const delivered = await options.post({
        type: 'progress',
        jobId: options.jobId,
        progress: {
          stage: 'semantic-trace',
          operation: 'runtime-result-produced',
          detail: 'runtime-result-produced',
        },
      });
      if (!delivered) {
        throw new Error('Lifecycle result barrier was not delivered');
      }
      await new Promise<void>(() => undefined);
    },
  };
}
