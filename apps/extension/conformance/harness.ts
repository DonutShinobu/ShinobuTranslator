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
} from './scenarios';
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
  'providerReports',
]);
const ARTIFACT_FIELDS = new Set([
  'contentType',
  'width',
  'height',
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
const PARALLEL_PROGRESS_STAGES = new Set(['translate', 'inpaint']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const CONFORMANCE_EXCLUDED_FIELDS = Object.freeze([
  'progress[].detail',
  'result.artifact.byteLength',
  'result.artifact.nativeBytesSha256',
  'result.record.ocr[].box',
  'result.record.ocr[].quad',
  'result.record.ocr[].confidence',
  'result.record.translations[].box',
  'result.record.translations[].quad',
] as const);

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

function normalizeRecord(record: PipelineRecord): {
  schemaVersion: PipelineRecord['schemaVersion'];
  workingCopy: PipelineRecord['workingCopy'];
  ocr: NormalizedRecordRegion[];
  translations: NormalizedRecordRegion[];
} {
  assertOnlyFields(record, RECORD_FIELDS, 'result.record');
  assertOnlyFields(
    record.workingCopy,
    WORKING_COPY_FIELDS,
    'result.record.workingCopy',
  );
  const idMap = new Map<string, string>();
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
    schemaVersion: record.schemaVersion,
    workingCopy: clone(record.workingCopy),
    ocr,
    translations,
  };
}

function normalizeProviderReports(
  reports: readonly ProviderExecutionReport[],
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
    return clone(report);
  });
  const expectedTargets = new Set(
    WEBGPU_CONFORMANCE_PROVIDER_POLICY.rules.map(
      (rule) => `${rule.model}:${rule.stage}`,
    ),
  );
  const actualTargets = new Set(
    normalized.map((report) => `${report.model}:${report.stage}`),
  );
  if (
    normalized.length !== expectedTargets.size
    || actualTargets.size !== expectedTargets.size
    || [...expectedTargets].some((target) => !actualTargets.has(target))
  ) {
    throw new TypeError(
      'successful conformance requires all four WebGPU model stages',
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
  if (observation.result.status !== 'completed') {
    throw new TypeError('successful translate scenario must complete with text');
  }
  if (observation.finalizationCount !== 1) {
    throw new TypeError('conformance execution must finalize exactly once');
  }
  if (observation.commitCount !== 1) {
    throw new TypeError('conformance execution must commit exactly once');
  }
  assertOnlyFields(observation.result, RESULT_FIELDS, 'result');
  assertOnlyFields(observation.result.artifact, ARTIFACT_FIELDS, 'result.artifact');
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
  if (
    normalizedRecord.translations.length === 0
    || normalizedRecord.translations.some(
      (region) =>
        region.translatedText
          !== observation.request.fixedTranslationResponse,
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
    resultStatus: 'completed',
    artifact: {
      contentType: observation.result.artifact.contentType,
      width: observation.result.artifact.width,
      height: observation.result.artifact.height,
    },
    record: normalizedRecord,
    providerReports: normalizeProviderReports(
      observation.result.providerReports,
    ),
    failure: null,
    cancellation: null,
    finalizationCount: 1,
    commitCount: 1,
    excludedFields: CONFORMANCE_EXCLUDED_FIELDS,
  };
}

function firstDifference(
  left: unknown,
  right: unknown,
  path = 'observation',
): string | null {
  if (Object.is(left, right)) return null;
  if (
    !left
    || !right
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return path;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([
    ...Object.keys(leftRecord),
    ...Object.keys(rightRecord),
  ])].sort();
  for (const key of keys) {
    if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) {
      return `${path}.${key}`;
    }
    const difference = firstDifference(
      leftRecord[key],
      rightRecord[key],
      `${path}.${key}`,
    );
    if (difference) return difference;
  }
  return null;
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
  const difference = firstDifference(chrome, firefox);
  if (difference) throw new ConformanceMismatchError(difference);
  return { matches: true };
}
