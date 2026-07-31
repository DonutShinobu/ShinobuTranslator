import type {
  PipelineCancellationReason,
  PipelineConfig,
  PipelineFailureEnvelope,
  PipelineProgress,
  PipelineRecord,
  ProviderExecutionContract,
  ProviderExecutionPolicy,
  ProviderExecutionReport,
  WorkingCopySpec,
} from '@shinobu/image-pipeline';

export type ConformanceBrowser = 'chrome' | 'firefox';

export type ConformanceHost = 'broker-offscreen' | 'event-page-direct';

export type ConformanceScenario = {
  id: 'successful-translate-v1';
  input: {
    path: string;
    contentType: 'image/png';
  };
  config: PipelineConfig;
  workingCopy: WorkingCopySpec;
  fixedTranslationResponse: string;
  providerPolicy: ProviderExecutionPolicy;
  resourcePaths: {
    font: string;
    modelManifest: string;
    modelChecksums: string;
  };
};

export type ConformanceRequestObservation = {
  inputSha256: string;
  config: PipelineConfig;
  workingCopy: WorkingCopySpec;
  fixedTranslationResponse: string;
  providerContract: ProviderExecutionContract;
  resourceDigests: {
    font: string;
    modelManifest: string;
    modelChecksums: string;
  };
};

export type ConformanceArtifactObservation = {
  contentType: string;
  width: number;
  height: number;
  byteLength: number;
  nativeBytesSha256: string;
};

export type ConformanceResultObservation = {
  status: 'completed' | 'no-translatable-text';
  artifact: ConformanceArtifactObservation;
  record: PipelineRecord;
  providerReports: readonly ProviderExecutionReport[];
};

export type ConformanceObservation = {
  schemaVersion: 1;
  browser: ConformanceBrowser;
  host: ConformanceHost;
  scenarioId: ConformanceScenario['id'];
  request: ConformanceRequestObservation;
  progress: PipelineProgress[];
  result: ConformanceResultObservation | null;
  failure: PipelineFailureEnvelope | null;
  cancellation: PipelineCancellationReason | null;
  finalizationCount: number;
  commitCount: number;
};

export type NormalizedRecordRegion = {
  id: string;
  order: number;
  presentFields: string[];
  direction?: 'h' | 'v';
  text?: string;
  sourceText?: string;
  translatedText?: string;
  translatedColumns?: string[];
};

export type NormalizedConformanceObservation = {
  schemaVersion: 1;
  scenarioId: ConformanceScenario['id'];
  request: ConformanceRequestObservation;
  serialProgress: Array<Omit<PipelineProgress, 'detail'>>;
  parallelProgress: Record<
    string,
    Array<Omit<PipelineProgress, 'detail'>>
  >;
  resultStatus: 'completed';
  artifact: Pick<
    ConformanceArtifactObservation,
    'contentType' | 'width' | 'height'
  >;
  record: {
    schemaVersion: PipelineRecord['schemaVersion'];
    workingCopy: PipelineRecord['workingCopy'];
    ocr: NormalizedRecordRegion[];
    translations: NormalizedRecordRegion[];
  };
  providerReports: readonly ProviderExecutionReport[];
  failure: null;
  cancellation: null;
  finalizationCount: 1;
  commitCount: 1;
  excludedFields: readonly string[];
};

export type ConformanceDriverResult = {
  observation: ConformanceObservation;
  browserVersion: string;
  packagePath: string;
};

export type SemanticTraceScenarioId =
  | 'detector-webgpu-failure-v1'
  | 'translation-retry-exhaustion-v1'
  | 'parallel-user-cancellation-v1'
  | 'host-disconnect-recovery-v1';

export type SemanticTraceExecutionObservation = {
  ordinal: number;
  barriers: string[];
  progress: PipelineProgress[];
  resultProducedCount: number;
  result: ConformanceResultObservation | null;
  failure: PipelineFailureEnvelope | null;
  cancellation: {
    code: 'TASK_CANCELLED';
    reason: PipelineCancellationReason;
  } | null;
  finalizationCount: number;
  resourceSettlementCount: number;
  commitCount: number;
  publicEventsAfterTerminal: number;
};

export type SemanticTraceObservation = {
  schemaVersion: 1;
  browser: ConformanceBrowser;
  host: ConformanceHost;
  scenarioId: SemanticTraceScenarioId;
  hostRebuildCount: number;
  executions: SemanticTraceExecutionObservation[];
};

export type NormalizedSemanticTraceExecution = Omit<
  SemanticTraceExecutionObservation,
  'result' | 'failure' | 'cancellation'
> & {
  terminal:
    | { kind: 'completed'; status: ConformanceResultObservation['status'] }
    | { kind: 'failure'; failure: PipelineFailureEnvelope }
    | {
        kind: 'cancelled';
        code: 'TASK_CANCELLED';
        reason: PipelineCancellationReason;
      };
};

export type NormalizedSemanticTraceObservation = {
  schemaVersion: 1;
  scenarioId: SemanticTraceScenarioId;
  hostRebuildCount: number;
  executions: NormalizedSemanticTraceExecution[];
};

export type SemanticConformanceDriverResult = {
  observations: SemanticTraceObservation[];
  browserVersion: string;
  packagePath: string;
};
