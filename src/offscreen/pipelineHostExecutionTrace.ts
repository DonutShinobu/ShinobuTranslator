import type {
  ProviderExecutionCapability,
} from '@shinobu/image-pipeline';
import type {
  LocalPipelineHostMessage,
} from '../shared/localPipelineProtocol';
import type {
  TextTranslationTransport,
} from '../translators/transport';

export type PipelineHostExecutionTrace = {
  recordFinalization(): Promise<void>;
  recordResourceSettlement(): Promise<void>;
  afterArtifactChunk(artifact: 'result' | 'debug', index: number): Promise<void>;
  dispose(): void;
};

export function createPipelineHostExecutionTrace(_options: {
  executionOrdinal: number;
  jobId: string;
  providerExecution: ProviderExecutionCapability;
  translationTransport: TextTranslationTransport;
  post(message: LocalPipelineHostMessage): Promise<boolean>;
}): PipelineHostExecutionTrace {
  return {
    recordFinalization: async () => undefined,
    recordResourceSettlement: async () => undefined,
    afterArtifactChunk: async () => undefined,
    dispose: () => undefined,
  };
}
