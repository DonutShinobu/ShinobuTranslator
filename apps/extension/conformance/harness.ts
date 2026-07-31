import type {
  PipelineProgress,
  PipelineRecord,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import {
  isProviderExecutionReport,
} from '@shinobu/image-pipeline';
import {
  WEBGPU_CONFORMANCE_PROVIDER_POLICY,
  conformanceScenarioById,
} from './scenarios';
import {
  CONFORMANCE_FIELD_CLASSIFICATION,
  firstDifference,
  type GoldenComparable,
  type NumericObservation,
} from './comparator';
import type {
  ConformanceObservation,
  NormalizedConformanceObservation,
  NormalizedRecordRegion,
} from './types';

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'browser',
  'host',
  'scenarioId',
  'request',
  'progress',
  'result',
  'failure',
  'cancellation',
  'finalizationCount',
  'commitCount',
]);
const REQUEST_FIELDS = new Set([
  'inputSha256',
  'config',
  'workingCopy',
  'fixedTranslationResponse',
  'providerContract',
  'resourceDigests',
]);
const CONFIG_FIELDS = new Set([
  'sourceLang',
  'targetLang',
  'translator',
  'llmProvider',
  'llmAuthMode',
  'llmBaseUrl',
  'llmModel',
  'llmUseCustomModel',
  'llmThinkingLevel',
  'translationContext',
  'typesetDebug',
  'eraseDebug',
  'collectDebugLog',
  'ocrEngine',
  'ocrPostFilter',
  'processMode',
  'diagnosticRunId',
]);
const WORKING_COPY_FIELDS = new Set([
  'width',
  'height',
  'spec',
  'sourceToWorkingCopy',
]);
const RECORD_FIELDS = new Set([
  'schemaVersion',
  'workingCopy',
  'ocr',
  'translations',
]);
const OCR_FIELDS = new Set([
  'id',
  'order',
  'box',
  'quad',
  'direction',
  'confidence',
  'text',
]);
const TRANSLATION_FIELDS = new Set([
  'id',
  'order',
  'box',
  'quad',
  'direction',
  'sourceText',
  'translatedText',
  'translatedColumns',
]);
const PROGRESS_FIELDS = new Set([
  'stage',
  'operation',
  'completed',
  'total',
  'retry',
  'detail',
]);
const RESULT_FIELDS = new Set([
  'status',
  'artifact',
  'record',
  'typesetMetrics',
  'providerReports',
]);
const ARTIFACT_FIELDS = new Set([
  'contentType',
  'width',
  'height',
  'channelOrder',
  'colorSpace',
  'decodedRgbaBase64',
  'inputEquivalentToSource',
  'byteLength',
  'nativeBytesSha256',
]);
const PROVIDER_REPORT_FIELDS = new Set([
  'schemaVersion',
  'contract',
  'model',
  'stage',
  'requiredProviders',
  'attempts',
  'finalProvider',
  'fallbackTrace',
  'satisfied',
]);
const BOX_FIELDS = new Set(['x', 'y', 'width', 'height']);
const QUAD_POINT_FIELDS = new Set(['x', 'y']);
const SOURCE_NATIVE_SPEC_FIELDS = new Set(['strategy']);
const NORMALIZED_SPEC_FIELDS = new Set([
  'strategy',
  'sourceSize',
  'size',
  'imageOrientation',
  'background',
]);
const IMAGE_SIZE_FIELDS = new Set(['width', 'height']);
const IDENTITY_TRANSFORM_FIELDS = new Set(['kind']);
const SCALE_TRANSFORM_FIELDS = new Set(['kind', 'scaleX', 'scaleY']);
const PROVIDER_CONTRACT_FIELDS = new Set(['id', 'version']);
const PROVIDER_ATTEMPT_FIELDS = new Set([
  'attempt',
  'provider',
  'outcome',
  'reason',
]);
const PROVIDER_FALLBACK_FIELDS = new Set(['from', 'to', 'reason']);
const PARALLEL_PROGRESS_STAGES = new Set(['translate', 'inpaint']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const CONFORMANCE_EXCLUDED_FIELDS =
  CONFORMANCE_FIELD_CLASSIFICATION.excluded;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `unclassified observation field at ${path}.${unknown[0]}`,
    );
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeProgress(progress: readonly PipelineProgress[]): {
  serialProgress: Array<Omit<PipelineProgress, 'detail'>>;
  parallelProgress: Record<
    string,
    Array<Omit<PipelineProgress, 'detail'>>
  >;
} {
  const serialProgress: Array<Omit<PipelineProgress, 'detail'>> = [];
  const parallel = new Map<
    string,
    Array<Omit<PipelineProgress, 'detail'>>
  >();
  for (const [index, event] of progress.entries()) {
    assertOnlyFields(event, PROGRESS_FIELDS, `progress[${index}]`);
    const normalized = {
      stage: event.stage,
      operation: event.operation,
      ...(event.completed === undefined
        ? {}
        : { completed: event.completed }),
      ...(event.total === undefined ? {} : { total: event.total }),
      ...(event.retry === undefined ? {} : { retry: clone(event.retry) }),
    };
    if (!PARALLEL_PROGRESS_STAGES.has(event.stage)) {
      serialProgress.push(normalized);
      continue;
    }
    const key = `${event.stage}:${event.operation}`;
    const stream = parallel.get(key) ?? [];
    stream.push(normalized);
    parallel.set(key, stream);
  }
  return {
    serialProgress,
    parallelProgress: Object.fromEntries(
      [...parallel.entries()].sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
  };
}

function addBoxMetrics(
  target: Record<string, number>,
  path: string,
  box: { x: number; y: number; width: number; height: number },
): void {
  assertOnlyFields(box, BOX_FIELDS, path);
  target[`${path}.x`] = box.x;
  target[`${path}.y`] = box.y;
  target[`${path}.width`] = box.width;
  target[`${path}.height`] = box.height;
}

function addQuadMetrics(
  target: Record<string, number>,
  path: string,
  quad: readonly { x: number; y: number }[] | undefined,
): void {
  if (!quad) return;
  if (quad.length !== 4) {
    throw new TypeError(`${path} must contain exactly four points`);
  }
  for (const [index, point] of quad.entries()) {
    assertOnlyFields(point, QUAD_POINT_FIELDS, `${path}[${index}]`);
    target[`${path}[${index}].x`] = point.x;
    target[`${path}[${index}].y`] = point.y;
  }
}

function normalizeRecord(record: PipelineRecord): {
  record: {
    schemaVersion: PipelineRecord['schemaVersion'];
    workingCopy: PipelineRecord['workingCopy'];
    ocr: NormalizedRecordRegion[];
    translations: NormalizedRecordRegion[];
  };
  numeric: Pick<NumericObservation, 'confidence' | 'geometry' | 'quad'>;
} {
  assertOnlyFields(record, RECORD_FIELDS, 'result.record');
  assertOnlyFields(
    record.workingCopy,
    WORKING_COPY_FIELDS,
    'result.record.workingCopy',
  );
  const specFields = record.workingCopy.spec.strategy === 'source-native'
    ? SOURCE_NATIVE_SPEC_FIELDS
    : NORMALIZED_SPEC_FIELDS;
  assertOnlyFields(
    record.workingCopy.spec,
    specFields,
    'result.record.workingCopy.spec',
  );
  if (record.workingCopy.spec.strategy === 'normalized') {
    assertOnlyFields(
      record.workingCopy.spec.sourceSize,
      IMAGE_SIZE_FIELDS,
      'result.record.workingCopy.spec.sourceSize',
    );
    assertOnlyFields(
      record.workingCopy.spec.size,
      IMAGE_SIZE_FIELDS,
      'result.record.workingCopy.spec.size',
    );
  }
  const transformFields = record.workingCopy.sourceToWorkingCopy.kind
    === 'identity'
    ? IDENTITY_TRANSFORM_FIELDS
    : SCALE_TRANSFORM_FIELDS;
  assertOnlyFields(
    record.workingCopy.sourceToWorkingCopy,
    transformFields,
    'result.record.workingCopy.sourceToWorkingCopy',
  );
  const idMap = new Map<string, string>();
  const confidence: Record<string, number> = {};
  const geometry: Record<string, number> = {};
  const quad: Record<string, number> = {};
  const normalizedId = (id: string): string => {
    if (!UUID_PATTERN.test(id)) {
      throw new TypeError('result.record region id must be a UUID');
    }
    const existing = idMap.get(id);
    if (existing) return existing;
    const canonical = `region-${idMap.size + 1}`;
    idMap.set(id, canonical);
    return canonical;
  };
  const ocr = record.ocr.map((region, index) => {
    assertOnlyFields(region, OCR_FIELDS, `result.record.ocr[${index}]`);
    if (idMap.has(region.id)) {
      throw new TypeError(`result.record contains duplicate OCR id ${region.id}`);
    }
    addBoxMetrics(geometry, `ocr[${index}].box`, region.box);
    addQuadMetrics(quad, `ocr[${index}].quad`, region.quad);
    if (region.confidence !== undefined) {
      confidence[`ocr[${index}].confidence`] = region.confidence;
    }
    return {
      id: normalizedId(region.id),
      order: region.order,
      presentFields: Object.keys(region).sort(),
      ...(region.direction === undefined
        ? {}
        : { direction: region.direction }),
      text: region.text,
    };
  });
  const translations = record.translations.map((region, index) => {
    assertOnlyFields(
      region,
      TRANSLATION_FIELDS,
      `result.record.translations[${index}]`,
    );
    addBoxMetrics(geometry, `translations[${index}].box`, region.box);
    addQuadMetrics(quad, `translations[${index}].quad`, region.quad);
    return {
      id: normalizedId(region.id),
      order: region.order,
      presentFields: Object.keys(region).sort(),
      ...(region.direction === undefined
        ? {}
        : { direction: region.direction }),
      sourceText: region.sourceText,
      translatedText: region.translatedText,
      ...(region.translatedColumns === undefined
        ? {}
        : { translatedColumns: [...region.translatedColumns] }),
    };
  });
  return {
    record: {
      schemaVersion: record.schemaVersion,
      workingCopy: clone(record.workingCopy),
      ocr,
      translations,
    },
    numeric: { confidence, geometry, quad },
  };
}

function normalizeTypesetMetrics(
  value: unknown,
): Pick<NumericObservation, 'font' | 'layout'> {
  assertOnlyFields(
    value,
    new Set(['font', 'layout']),
    'result.typesetMetrics',
  );
  const normalized = {} as Pick<NumericObservation, 'font' | 'layout'>;
  for (const category of ['font', 'layout'] as const) {
    const metrics = value[category];
    if (!isRecord(metrics)) {
      throw new TypeError(`result.typesetMetrics.${category} must be an object`);
    }
    const entries = Object.entries(metrics)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [path, metric] of entries) {
      if (typeof metric !== 'number' || !Number.isFinite(metric)) {
        throw new TypeError(
          `result.typesetMetrics.${category}.${path} must be finite`,
        );
      }
    }
    normalized[category] = Object.fromEntries(entries) as Record<string, number>;
  }
  return normalized;
}

function normalizeProviderReports(
  reports: readonly ProviderExecutionReport[],
  expectedTargets: readonly string[],
): readonly ProviderExecutionReport[] {
  const normalized = reports.map((report, index) => {
    assertOnlyFields(
      report,
      PROVIDER_REPORT_FIELDS,
      `result.providerReports[${index}]`,
    );
    if (!isProviderExecutionReport(report)) {
      throw new TypeError(`invalid provider report at index ${index}`);
    }
    assertOnlyFields(
      report.contract,
      PROVIDER_CONTRACT_FIELDS,
      `result.providerReports[${index}].contract`,
    );
    report.attempts.forEach((attempt, attemptIndex) => assertOnlyFields(
      attempt,
      PROVIDER_ATTEMPT_FIELDS,
      `result.providerReports[${index}].attempts[${attemptIndex}]`,
    ));
    report.fallbackTrace.forEach((fallback, fallbackIndex) => assertOnlyFields(
      fallback,
      PROVIDER_FALLBACK_FIELDS,
      `result.providerReports[${index}].fallbackTrace[${fallbackIndex}]`,
    ));
    return clone(report);
  });
  const expectedTargetSet = new Set(expectedTargets);
  const actualTargets = new Set(
    normalized.map((report) => `${report.model}:${report.stage}`),
  );
  if (
    normalized.length !== expectedTargetSet.size
    || actualTargets.size !== expectedTargetSet.size
    || [...expectedTargetSet].some((target) => !actualTargets.has(target))
  ) {
    throw new TypeError(
      'conformance provider reports do not match expected reached stages',
    );
  }
  for (const report of normalized) {
    if (
      report.contract.id
        !== WEBGPU_CONFORMANCE_PROVIDER_POLICY.contract.id
      || report.contract.version
        !== WEBGPU_CONFORMANCE_PROVIDER_POLICY.contract.version
      || report.requiredProviders.length !== 1
      || report.requiredProviders[0] !== 'webgpu'
      || report.attempts.length === 0
      || report.attempts.some((attempt) => attempt.provider !== 'webgpu')
      || report.attempts.slice(0, -1).some((attempt) =>
        attempt.outcome !== 'failed'
        || attempt.reason !== 'session-lost')
      || report.fallbackTrace.length !== 0
      || report.finalProvider !== 'webgpu'
      || !report.satisfied
    ) {
      throw new TypeError(
        'successful conformance requires satisfied WebGPU provider reports',
      );
    }
  }
  return normalized;
}

export function normalizeConformanceObservation(
  observation: ConformanceObservation,
): NormalizedConformanceObservation {
  assertOnlyFields(observation, TOP_LEVEL_FIELDS, 'observation');
  if (observation.schemaVersion !== 1) {
    throw new TypeError('unsupported conformance observation schema');
  }
  const scenario = conformanceScenarioById(observation.scenarioId);
  assertOnlyFields(observation.request, REQUEST_FIELDS, 'request');
  assertOnlyFields(observation.request.config, CONFIG_FIELDS, 'request.config');
  assertOnlyFields(
    observation.request.workingCopy,
    new Set(['strategy', 'sourceSize', 'size', 'imageOrientation', 'background']),
    'request.workingCopy',
  );
  assertOnlyFields(
    observation.request.providerContract,
    new Set(['id', 'version']),
    'request.providerContract',
  );
  assertOnlyFields(
    observation.request.resourceDigests,
    new Set(['font', 'modelManifest', 'modelChecksums']),
    'request.resourceDigests',
  );
  if (observation.failure !== null || observation.cancellation !== null) {
    throw new TypeError('successful conformance observation must not fail or cancel');
  }
  if (!observation.result) {
    throw new TypeError('successful conformance observation must include a result');
  }
  if (observation.result.status !== scenario.expectedStatus) {
    throw new TypeError(
      `scenario ${scenario.id} must finish as ${scenario.expectedStatus}`,
    );
  }
  if (observation.finalizationCount !== 1) {
    throw new TypeError('conformance execution must finalize exactly once');
  }
  if (observation.commitCount !== 1) {
    throw new TypeError('conformance execution must commit exactly once');
  }
  assertOnlyFields(observation.result, RESULT_FIELDS, 'result');
  assertOnlyFields(observation.result.artifact, ARTIFACT_FIELDS, 'result.artifact');
  if (observation.request.inputSha256 !== scenario.input.sha256) {
    throw new TypeError(`scenario ${scenario.id} input SHA-256 does not match matrix`);
  }
  if (
    observation.result.artifact.channelOrder !== 'rgba'
    || observation.result.artifact.colorSpace !== 'srgb'
    || observation.result.artifact.decodedRgbaBase64.length === 0
  ) {
    throw new TypeError('conformance artifact must include decoded sRGB RGBA');
  }
  const finalizationProgress = observation.progress.filter(
    (event) => event.stage === 'finalize',
  );
  if (finalizationProgress.length !== 1) {
    throw new TypeError('progress must observe finalization exactly once');
  }
  if (observation.progress.filter((event) => event.stage === 'done').length !== 1) {
    throw new TypeError('progress must observe done exactly once');
  }
  const normalizedProgress = normalizeProgress(observation.progress);
  const normalizedRecord = normalizeRecord(observation.result.record);
  const typesetMetrics = normalizeTypesetMetrics(
    observation.result.typesetMetrics,
  );
  if (scenario.expectedStatus === 'no-translatable-text') {
    if (
      normalizedRecord.record.ocr.length !== 0
      || normalizedRecord.record.translations.length !== 0
      || !observation.result.artifact.inputEquivalentToSource
    ) {
      throw new TypeError(
        'no-translatable-text must return input-equivalent RGBA and an empty record',
      );
    }
  } else if (
    scenario.config.processMode === 'translate'
    && (
      normalizedRecord.record.translations.length === 0
      || normalizedRecord.record.translations.some(
      (region) =>
        region.translatedText
          !== observation.request.fixedTranslationResponse,
      )
    )
  ) {
    throw new TypeError(
      'successful conformance record must contain the fixed translation response',
    );
  }
  return {
    schemaVersion: 1,
    scenarioId: observation.scenarioId,
    request: clone(observation.request),
    ...normalizedProgress,
    resultStatus: observation.result.status,
    artifact: {
      contentType: observation.result.artifact.contentType,
      width: observation.result.artifact.width,
      height: observation.result.artifact.height,
      channelOrder: observation.result.artifact.channelOrder,
      colorSpace: observation.result.artifact.colorSpace,
      inputEquivalentToSource:
        observation.result.artifact.inputEquivalentToSource,
    },
    record: normalizedRecord.record,
    providerReports: normalizeProviderReports(
      observation.result.providerReports,
      scenario.expectedProviderTargets,
    ),
    numeric: {
      ...normalizedRecord.numeric,
      ...typesetMetrics,
    },
    decodedRgbaBase64: observation.result.artifact.decodedRgbaBase64,
    failure: null,
    cancellation: null,
    finalizationCount: 1,
    commitCount: 1,
    excludedFields: CONFORMANCE_EXCLUDED_FIELDS,
  };
}

export class ConformanceMismatchError extends Error {
  constructor(readonly path: string) {
    super(`Chrome and Firefox conformance observations differ at ${path}`);
    this.name = 'ConformanceMismatchError';
  }
}

export function compareConformanceObservations(
  chrome: NormalizedConformanceObservation,
  firefox: NormalizedConformanceObservation,
): { matches: true } {
  const { numeric: _chromeNumeric, decodedRgbaBase64: _chromeRgba, ...chromeStrict }
    = chrome;
  const { numeric: _firefoxNumeric, decodedRgbaBase64: _firefoxRgba, ...firefoxStrict }
    = firefox;
  const difference = firstDifference(chromeStrict, firefoxStrict);
  if (difference) throw new ConformanceMismatchError(difference);
  return { matches: true };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toGoldenComparable(
  observation: NormalizedConformanceObservation,
): GoldenComparable {
  const { numeric, decodedRgbaBase64, ...strict } = observation;
  return {
    strict,
    numeric,
    rgba: {
      width: observation.artifact.width,
      height: observation.artifact.height,
      channelOrder: observation.artifact.channelOrder,
      colorSpace: observation.artifact.colorSpace,
      data: decodeBase64(decodedRgbaBase64),
    },
  };
}
