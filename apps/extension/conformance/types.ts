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
import type {
  NumericObservation,
} from './comparator';

export type ConformanceBrowser = 'chrome' | 'firefox';

export type ConformanceHost = 'broker-offscreen' | 'event-page-direct';

export type ConformanceCoverage =
  | 'vertical'
  | 'horizontal'
  | 'mixed'
  | 'irregular-quad'
  | 'font-punctuation-latin'
  | 'long-high-resolution'
  | 'erase'
  | 'no-text-opaque'
  | 'no-text-transparent';

export type ConformanceScenarioId =
  | 'translate-vertical-sparse-v1'
  | 'translate-horizontal-jpeg-v1'
  | 'translate-mixed-dense-v1'
  | 'translate-irregular-quad-v1'
  | 'translate-font-punctuation-latin-v1'
  | 'translate-long-high-resolution-v1'
  | 'erase-complete-v1'
  | 'no-text-opaque-jpeg-v1'
  | 'no-text-transparent-png-v1';

export type ConformanceScenario = {
  matrixVersion: 1;
  id: ConformanceScenarioId;
  input: {
    path: string;
    contentType: 'image/png' | 'image/jpeg';
    sha256: string;
    alpha: 'opaque' | 'transparent';
  };
  expectedStatus: 'completed' | 'no-translatable-text';
  coverage: readonly ConformanceCoverage[];
  requiresInputEquivalentResult: boolean;
  expectedProviderTargets: readonly string[];
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
  channelOrder: 'rgba';
  colorSpace: 'srgb';
  decodedRgbaBase64: string;
  inputEquivalentToSource: boolean;
  byteLength: number;
  nativeBytesSha256: string;
};

export type ConformanceResultObservation = {
  status: 'completed' | 'no-translatable-text';
  artifact: ConformanceArtifactObservation;
  record: PipelineRecord;
  typesetMetrics: Pick<NumericObservation, 'font' | 'layout'>;
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
  resultStatus: 'completed' | 'no-translatable-text';
  artifact: Pick<
    ConformanceArtifactObservation,
    | 'contentType'
    | 'width'
    | 'height'
    | 'channelOrder'
    | 'colorSpace'
    | 'inputEquivalentToSource'
  >;
  record: {
    schemaVersion: PipelineRecord['schemaVersion'];
    workingCopy: PipelineRecord['workingCopy'];
    ocr: NormalizedRecordRegion[];
    translations: NormalizedRecordRegion[];
  };
  providerReports: readonly ProviderExecutionReport[];
  numeric: NumericObservation;
  decodedRgbaBase64: string;
  failure: null;
  cancellation: null;
  finalizationCount: 1;
  commitCount: 1;
  excludedFields: readonly string[];
};

export type ConformanceDriverResult = {
  observations: ConformanceObservation[];
  browserVersion: string;
  packagePath: string;
};
