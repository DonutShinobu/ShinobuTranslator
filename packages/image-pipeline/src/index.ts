import {
  TranslationCancelledError,
  TranslationExecutionError,
  type TranslationCancellationReason,
  type TranslationFailure,
  type TranslationTask,
} from '@shinobu/translator-core';
import type {
  LlmProvider,
  LlmThinkingLevel,
  TextTranslator,
  TranslationReferenceContext,
} from '@shinobu/text-translation';
import type { ModelRuntime } from '@shinobu/model-runtime';
import type { DiagnosticLogObserver } from '@shinobu/diagnostics';
import type { PlatformProvider } from './runtime/platform';
import { runPipeline, PipelineStageError } from './pipeline/orchestrator';
import { disposePipelineArtifacts } from './pipeline/resources';
import { registerTypesetFonts } from './pipeline/typeset/fontRuntime';
import { canvasToPngBlob, summarizePipelineArtifacts } from './protocol';
import type { PipelineArtifacts } from './types';
import type { DetectionFallbackStrategy } from './pipeline/detect';

export type {
  LlmProvider,
  LlmThinkingLevel,
  TranslationReferenceContext,
} from '@shinobu/text-translation';

export type PipelinePlatform = PlatformProvider & {
  prepareSource?(
    source: Blob,
    workingCopy: Readonly<WorkingCopySpec>,
  ): Promise<Blob>;
};

export type {
  PipelineCanvas,
  PipelineFontDescriptors,
  PipelineImage,
  PipelineImageData,
  PipelineRenderingContext,
  PipelineTextMetrics,
  PlatformProvider,
} from './runtime/platform';

export type ImagePipelineExecution = {
  textTranslator: TextTranslator;
};

export type ImagePipelineDependencies = {
  platform: PipelinePlatform;
  modelRuntime: ModelRuntime;
  detectionFallbackStrategy: DetectionFallbackStrategy;
  fontSource?: (path: string) => string;
  observer?: DiagnosticLogObserver;
};

export type { DetectionFallbackStrategy } from './pipeline/detect';

export interface ImagePipeline {
  run(
    request: ImagePipelineRequest,
    execution: ImagePipelineExecution,
  ): TranslationTask<PipelineProgress, ImagePipelineResult>;
  whenIdle(): Promise<void>;
  dispose(reason?: unknown): Promise<void>;
}

export const PIPELINE_RECORD_SCHEMA_VERSION = 2 as const;

/**
 * Immutable choices that determine the produced image. Runtime credentials and
 * host resources deliberately do not belong to this value.
 */
export type PipelineConfig = {
  sourceLang: string;
  targetLang: string;
  translator: 'google_web' | 'llm';
  llmProvider: LlmProvider;
  llmAuthMode: 'api_key' | 'openai_oauth' | 'gemini_app';
  llmBaseUrl: string;
  llmModel: string;
  llmUseCustomModel?: boolean;
  llmThinkingLevel?: LlmThinkingLevel;
  translationContext?: TranslationReferenceContext;
  typesetDebug: boolean;
  eraseDebug: boolean;
  collectDebugLog: boolean;
  ocrEngine: 'paddleocr_v6_medium';
  ocrCompactActiveBatch?: boolean;
  ocrPostFilter?: 'off' | 'balanced';
  processMode: 'translate' | 'erase' | 'original';
  diagnosticRunId?: string;
};

export type ImageSize = {
  width: number;
  height: number;
};

export type SourceNativeWorkingCopySpec = {
  strategy: 'source-native';
};

export type NormalizedWorkingCopySpec = {
  strategy: 'normalized';
  sourceSize: ImageSize;
  size: ImageSize;
  imageOrientation: 'from-image';
  background: '#ffffff';
};

export type WorkingCopySpec =
  | SourceNativeWorkingCopySpec
  | NormalizedWorkingCopySpec;

export type ImagePipelineRequest = {
  source: Blob;
  config: Readonly<PipelineConfig>;
  workingCopy: Readonly<WorkingCopySpec>;
};

export type PipelineRetryProgress = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
};

export type PipelineProgress = {
  stage: string;
  operation: string;
  completed?: number;
  total?: number;
  retry?: PipelineRetryProgress;
  /**
   * Optional redacted diagnostic context. Hosts must not use it for control
   * flow or as the source of user-facing stage labels.
   */
  detail?: string;
};

export type PipelineFailureEnvelope = TranslationFailure;

export function isPipelineFailureEnvelope(
  value: unknown,
): value is PipelineFailureEnvelope {
  return isRecord(value)
    && typeof value.code === 'string'
    && (value.stage === undefined || typeof value.stage === 'string')
    && (value.scope === 'image' || value.scope === 'runtime')
    && typeof value.retryable === 'boolean'
    && typeof value.messageKey === 'string'
    && (value.diagnostics === undefined || isRecord(value.diagnostics));
}

export type PipelineCancellationReason = TranslationCancellationReason & {
  code:
    | 'user-requested'
    | 'owner-ended'
    | 'transport-disconnected'
    | 'runtime-disposed'
    | 'unknown';
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type QuadPoint = {
  x: number;
  y: number;
};

export type TextDirection = 'h' | 'v';

export type PipelineRecordRegion = {
  id: string;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  prob?: number;
  sourceText: string;
  translatedText: string;
  translatedColumns?: string[];
};

export type PipelineRecordSource = {
  image: ImageSize;
  ocr: readonly PipelineRecordRegion[];
  ordered: readonly PipelineRecordRegion[];
};

export function hasTranslatableText(
  source: Pick<PipelineRecordSource, 'ordered'>,
): boolean {
  return source.ordered.some((region) => region.sourceText.trim().length > 0);
}

export type PipelineOcrRecord = {
  id: string;
  order: number;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  confidence?: number;
  text: string;
};

export type PipelineTranslationRecord = {
  id: string;
  order: number;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  sourceText: string;
  translatedText: string;
  translatedColumns?: string[];
};

export type SourceToWorkingCopyTransform =
  | { kind: 'identity' }
  | {
      kind: 'scale';
      scaleX: number;
      scaleY: number;
    };

export type PipelineRecord = {
  schemaVersion: typeof PIPELINE_RECORD_SCHEMA_VERSION;
  workingCopy: {
    width: number;
    height: number;
    spec: WorkingCopySpec;
    sourceToWorkingCopy: SourceToWorkingCopyTransform;
  };
  ocr: PipelineOcrRecord[];
  translations: PipelineTranslationRecord[];
};

export type ImagePipelineResult = {
  status: 'completed' | 'no-translatable-text';
  image: Blob;
  debug?: Blob;
  record: PipelineRecord;
  diagnostics?: Readonly<Record<string, unknown>>;
};

type ImagePipelineExecutionOutput<Artifacts> = {
  status: ImagePipelineResult['status'];
  artifacts: Artifacts;
};

type RetryableOperation = {
  stage: string;
  operation: string;
};

type RuntimeExecutionContext = {
  signal: AbortSignal;
  reportProgress(progress: PipelineProgress): void;
  runOperation<T>(
    operation: RetryableOperation,
    action: () => Promise<T>,
  ): Promise<T>;
};

type RuntimeOptions<Artifacts> = {
  prepare?(context: RuntimeExecutionContext): Promise<void>;
  execute(
    request: ImagePipelineRequest,
    context: RuntimeExecutionContext,
  ): Promise<ImagePipelineExecutionOutput<Artifacts>>;
  finalize(
    output: ImagePipelineExecutionOutput<Artifacts>,
    request: ImagePipelineRequest,
    context: RuntimeExecutionContext,
  ): Promise<ImagePipelineResult>;
  release(output: ImagePipelineExecutionOutput<Artifacts>): void | Promise<void>;
  releaseFailure?(error: unknown): void | Promise<void>;
  releaseResult?(result: ImagePipelineResult): void | Promise<void>;
  dispose?(reason: PipelineCancellationReason): void | Promise<void>;
};

type ActiveExecution = {
  cancel(reason?: unknown): void;
  cleanup: Promise<void>;
};

const cancellationCodes = new Set<PipelineCancellationReason['code']>([
  'user-requested',
  'owner-ended',
  'transport-disconnected',
  'runtime-disposed',
  'unknown',
]);

const MAX_OPERATION_RETRIES = 2;
const MAX_OPERATION_ATTEMPTS = MAX_OPERATION_RETRIES + 1;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_RETRY_WAIT_BUDGET_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeCancellationReason(reason: unknown): PipelineCancellationReason {
  if (
    isRecord(reason)
    && typeof reason.code === 'string'
    && cancellationCodes.has(reason.code as PipelineCancellationReason['code'])
  ) {
    return {
      code: reason.code as PipelineCancellationReason['code'],
      messageKey: typeof reason.messageKey === 'string' && reason.messageKey
        ? reason.messageKey
        : `pipeline.cancelled.${reason.code}`,
      diagnosticSummary: typeof reason.diagnosticSummary === 'string'
        && reason.diagnosticSummary
        ? reason.diagnosticSummary
        : typeof reason.detail === 'string' && reason.detail
          ? reason.detail
        : undefined,
    };
  }
  if (reason instanceof Error) {
    return {
      code: 'unknown',
      messageKey: 'pipeline.cancelled.unknown',
      diagnosticSummary: reason.message || undefined,
    };
  }
  return {
    code: 'unknown',
    messageKey: 'pipeline.cancelled.unknown',
    diagnosticSummary: typeof reason === 'string' && reason ? reason : undefined,
  };
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || candidate instanceof Blob) {
      return;
    }
    if (visited.has(candidate)) return;
    visited.add(candidate);
    for (const child of Object.values(candidate)) visit(child);
    Object.freeze(candidate);
  };
  visit(clone);
  return clone;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateConfig(config: unknown): config is PipelineConfig {
  if (!isRecord(config)) return false;
  const allowedKeys = new Set([
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
    'ocrCompactActiveBatch',
    'ocrPostFilter',
    'processMode',
    'diagnosticRunId',
  ]);
  if (!hasOnlyKeys(config, allowedKeys)) return false;
  const stringKeys = [
    'sourceLang',
    'targetLang',
    'llmBaseUrl',
    'llmModel',
  ];
  return stringKeys.every((key) => typeof config[key] === 'string')
    && (config.translator === 'google_web' || config.translator === 'llm')
    && [
      'deepseek',
      'gemini',
      'glm',
      'kimi',
      'minimax',
      'mimo',
      'openai',
      'custom',
    ].includes(String(config.llmProvider))
    && (
      config.llmAuthMode === 'api_key'
      || config.llmAuthMode === 'openai_oauth'
      || config.llmAuthMode === 'gemini_app'
    )
    && (
      config.llmUseCustomModel === undefined
      || typeof config.llmUseCustomModel === 'boolean'
    )
    && (
      config.llmThinkingLevel === undefined
      || ['off', 'on', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
        String(config.llmThinkingLevel),
      )
    )
    && (
      config.translationContext === undefined
      || (
        isRecord(config.translationContext)
        && hasOnlyKeys(
          config.translationContext,
          new Set(['source', 'currentTweetText', 'quotedTweetText']),
        )
        && config.translationContext.source === 'x_tweet'
        && typeof config.translationContext.currentTweetText === 'string'
        && (
          config.translationContext.quotedTweetText === undefined
          || typeof config.translationContext.quotedTweetText === 'string'
        )
      )
    )
    && typeof config.typesetDebug === 'boolean'
    && typeof config.eraseDebug === 'boolean'
    && typeof config.collectDebugLog === 'boolean'
    && config.ocrEngine === 'paddleocr_v6_medium'
    && (
      config.ocrCompactActiveBatch === undefined
      || typeof config.ocrCompactActiveBatch === 'boolean'
    )
    && (
      config.ocrPostFilter === undefined
      || config.ocrPostFilter === 'off'
      || config.ocrPostFilter === 'balanced'
    )
    && (
      config.processMode === 'translate'
      || config.processMode === 'erase'
      || config.processMode === 'original'
    )
    && (
      config.diagnosticRunId === undefined
      || typeof config.diagnosticRunId === 'string'
    );
}

function validateWorkingCopySpec(spec: unknown): spec is WorkingCopySpec {
  if (!isRecord(spec)) return false;
  if (spec.strategy === 'source-native') {
    return hasOnlyKeys(spec, new Set(['strategy']));
  }
  return spec.strategy === 'normalized'
    && hasOnlyKeys(
      spec,
      new Set(['strategy', 'sourceSize', 'size', 'imageOrientation', 'background']),
    )
    && isRecord(spec.sourceSize)
    && hasOnlyKeys(spec.sourceSize, new Set(['width', 'height']))
    && isPositiveInteger(spec.sourceSize.width)
    && isPositiveInteger(spec.sourceSize.height)
    && isRecord(spec.size)
    && hasOnlyKeys(spec.size, new Set(['width', 'height']))
    && isPositiveInteger(spec.size.width)
    && isPositiveInteger(spec.size.height)
    && spec.imageOrientation === 'from-image'
    && spec.background === '#ffffff';
}

function canonicalWorkingCopySpec(spec: WorkingCopySpec): WorkingCopySpec {
  if (spec.strategy === 'source-native') return { strategy: 'source-native' };
  return {
    strategy: 'normalized',
    sourceSize: {
      width: spec.sourceSize.width,
      height: spec.sourceSize.height,
    },
    size: {
      width: spec.size.width,
      height: spec.size.height,
    },
    imageOrientation: 'from-image',
    background: '#ffffff',
  };
}

function validateRequest(request: unknown): asserts request is ImagePipelineRequest {
  if (
    !isRecord(request)
    || !(request.source instanceof Blob)
    || request.source.size <= 0
    || !validateConfig(request.config)
    || !validateWorkingCopySpec(request.workingCopy)
  ) {
    throw new ImagePipelineAdmissionError(
      'INVALID_REQUEST',
      '本地图片流水线请求结构无效',
    );
  }
}

function reportListenerError(error: unknown): void {
  const runtime = globalThis as typeof globalThis & {
    reportError?: (reason: unknown) => void;
  };
  if (runtime.reportError) {
    runtime.reportError(error);
  } else {
    console.error('Image pipeline progress listener failed', error);
  }
}

function defaultFailure(error: unknown, stage?: string): PipelineFailureEnvelope {
  if (isRecord(error) && isPipelineFailureEnvelope(error.failure)) {
    return cloneAndFreeze({
      code: error.failure.code,
      stage: error.failure.stage,
      scope: error.failure.scope,
      retryable: error.failure.retryable,
      messageKey: error.failure.messageKey,
      diagnostics: isRecord(error.failure.diagnostics)
        ? error.failure.diagnostics
        : undefined,
    });
  }
  return {
    code: 'PIPELINE_EXECUTION_FAILED',
    stage,
    scope: 'runtime',
    retryable: false,
    messageKey: 'pipeline.failure.execution',
    diagnostics: {
      name: error instanceof Error ? error.name : 'UnknownError',
    },
  };
}

function retryMetadata(error: unknown): {
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (!isRecord(error)) return { retryable: false };
  const status = typeof error.status === 'number' && Number.isFinite(error.status)
    ? error.status
    : undefined;
  const retryable = error.retryable === true
    || status === 429
    || (status !== undefined && status >= 500);
  const retryAfterMs = typeof error.retryAfterMs === 'number'
    && Number.isFinite(error.retryAfterMs)
    && error.retryAfterMs >= 0
    ? Math.min(MAX_RETRY_DELAY_MS, error.retryAfterMs)
    : undefined;
  return { retryable, retryAfterMs };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ImagePipelineAdmissionError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'RUNTIME_BUSY' | 'RUNTIME_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'ImagePipelineAdmissionError';
  }
}

export class ImagePipelineCancelledError extends TranslationCancelledError {
  constructor(readonly reason: PipelineCancellationReason) {
    super(reason);
    this.name = 'ImagePipelineCancelledError';
  }
}

export class ImagePipelineExecutionError extends TranslationExecutionError {
  constructor(
    readonly failure: PipelineFailureEnvelope,
    cause?: unknown,
  ) {
    super(failure, cause);
    this.name = 'ImagePipelineExecutionError';
  }
}

/**
 * Owns one browser-local image execution at a time, including admission,
 * cancellation settlement, finalization, and release of live artifacts.
 */
class ImagePipelineRuntime<Artifacts> {
  private active: ActiveExecution | null = null;
  private preparePromise: Promise<void> | null = null;
  private prepared = false;
  private closed = false;
  private disposal: Promise<void> | null = null;

  constructor(private readonly options: RuntimeOptions<Artifacts>) {}

  run(
    request: ImagePipelineRequest,
  ): TranslationTask<PipelineProgress, ImagePipelineResult> {
    if (this.closed) {
      throw new ImagePipelineAdmissionError(
        'RUNTIME_CLOSED',
        '本地图片流水线 runtime 已关闭',
      );
    }
    if (this.active) {
      throw new ImagePipelineAdmissionError(
        'RUNTIME_BUSY',
        '本地图片流水线 runtime 正在处理另一张图片',
      );
    }
    validateRequest(request);

    const immutableRequest: ImagePipelineRequest = {
      source: request.source,
      config: cloneAndFreeze(request.config),
      workingCopy: cloneAndFreeze(request.workingCopy),
    };
    const controller = new AbortController();
    const listeners = new Set<(progress: PipelineProgress) => void>();
    let latestProgress: PipelineProgress | undefined;
    let publicSettled = false;
    let activeStage: string | undefined;
    let remainingRetryWaitBudgetMs = MAX_RETRY_WAIT_BUDGET_MS;

    const reportProgress = (progress: PipelineProgress): void => {
      if (publicSettled || controller.signal.aborted) return;
      activeStage = progress.stage;
      latestProgress = cloneAndFreeze(progress);
      for (const listener of listeners) {
        try {
          listener(latestProgress);
        } catch (error) {
          reportListenerError(error);
        }
      }
    };
    const context: RuntimeExecutionContext = {
      signal: controller.signal,
      reportProgress,
      runOperation: async <T>(
        retryOperation: RetryableOperation,
        action: () => Promise<T>,
      ): Promise<T> => {
        for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
          this.throwIfCancelled(controller.signal);
          try {
            return await action();
          } catch (error) {
            this.throwIfCancelled(controller.signal);
            const retry = retryMetadata(error);
            if (!retry.retryable) throw error;
            if (attempt === MAX_OPERATION_ATTEMPTS) {
              throw new ImagePipelineExecutionError({
                code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
                stage: retryOperation.stage,
                scope: 'runtime',
                retryable: false,
                messageKey: retryOperation.stage === 'translate'
                  ? 'pipeline.failure.translationUnavailable'
                  : 'pipeline.failure.runtime',
                diagnostics: {
                  operation: retryOperation.operation,
                  attempts: attempt,
                },
              });
            }
            const exponentialDelayMs = 500 * 2 ** (attempt - 1);
            const requestedDelayMs = retry.retryAfterMs ?? exponentialDelayMs;
            const delayMs = Math.min(
              MAX_RETRY_DELAY_MS,
              requestedDelayMs,
              remainingRetryWaitBudgetMs,
            );
            if (delayMs <= 0) {
              throw new ImagePipelineExecutionError({
                code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
                stage: retryOperation.stage,
                scope: 'runtime',
                retryable: false,
                messageKey: retryOperation.stage === 'translate'
                  ? 'pipeline.failure.translationUnavailable'
                  : 'pipeline.failure.runtime',
                diagnostics: {
                  operation: retryOperation.operation,
                  attempts: attempt,
                },
              });
            }
            remainingRetryWaitBudgetMs -= delayMs;
            reportProgress({
              stage: retryOperation.stage,
              operation: retryOperation.operation,
              retry: {
                attempt: attempt + 1,
                maxAttempts: MAX_OPERATION_ATTEMPTS,
                delayMs,
              },
            });
            await waitForRetry(delayMs, controller.signal);
          }
        }
        throw new Error('unreachable operation retry state');
      },
    };

    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = (): void => {
      rejectCancellation(
        controller.signal.reason instanceof ImagePipelineCancelledError
          ? controller.signal.reason
          : new ImagePipelineCancelledError(
              normalizeCancellationReason(controller.signal.reason),
            ),
      );
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const operation = Promise.resolve().then(async () => {
      let output: ImagePipelineExecutionOutput<Artifacts> | undefined;
      let finalized: ImagePipelineResult | undefined;
      let finalizedReleased = false;
      let primaryFailure = false;
      try {
        this.throwIfCancelled(controller.signal);
        await this.ensurePrepared(context);
        this.throwIfCancelled(controller.signal);
        output = await this.options.execute(immutableRequest, context);
        this.throwIfCancelled(controller.signal);
        reportProgress({
          stage: 'finalize',
          operation: 'freeze-result',
        });
        finalized = await this.options.finalize(
          output,
          immutableRequest,
          context,
        );
        this.throwIfCancelled(controller.signal);
        return cloneAndFreeze(finalized);
      } catch (error) {
        primaryFailure = true;
        if (controller.signal.aborted) {
          try {
            await this.options.releaseFailure?.(error);
          } catch (cleanupError) {
            reportListenerError(cleanupError);
          }
          if (finalized && this.options.releaseResult) {
            try {
              await this.options.releaseResult(finalized);
            } catch (cleanupError) {
              reportListenerError(cleanupError);
            } finally {
              finalizedReleased = true;
            }
          }
          throw controller.signal.reason instanceof ImagePipelineCancelledError
            ? controller.signal.reason
            : new ImagePipelineCancelledError(
                normalizeCancellationReason(controller.signal.reason),
              );
        }
        if (error instanceof ImagePipelineExecutionError) throw error;
        try {
          await this.options.releaseFailure?.(error);
        } catch (cleanupError) {
          reportListenerError(cleanupError);
        }
        throw new ImagePipelineExecutionError(
          defaultFailure(error, activeStage),
        );
      } finally {
        if (output) {
          try {
            await this.options.release(output);
          } catch (cleanupError) {
            if (primaryFailure || controller.signal.aborted) {
              reportListenerError(cleanupError);
            } else {
              if (
                finalized
                && !finalizedReleased
                && this.options.releaseResult
              ) {
                try {
                  await this.options.releaseResult(finalized);
                } catch (resultCleanupError) {
                  reportListenerError(resultCleanupError);
                } finally {
                  finalizedReleased = true;
                }
              }
              throw new ImagePipelineExecutionError({
                code: 'PIPELINE_RESOURCE_RELEASE_FAILED',
                stage: 'finalize',
                scope: 'runtime',
                retryable: false,
                messageKey: 'pipeline.failure.resourceRelease',
                diagnostics: {
                  name: cleanupError instanceof Error
                    ? cleanupError.name
                    : 'UnknownError',
                },
              });
            }
          }
        }
        if (
          controller.signal.aborted
          && finalized
          && !finalizedReleased
          && this.options.releaseResult
        ) {
          try {
            await this.options.releaseResult(finalized);
          } catch (cleanupError) {
            reportListenerError(cleanupError);
          } finally {
            finalizedReleased = true;
          }
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof ImagePipelineCancelledError
            ? controller.signal.reason
            : new ImagePipelineCancelledError(
                normalizeCancellationReason(controller.signal.reason),
              );
        }
      }
    });

    const result = Promise.race([operation, cancellation]).finally(() => {
      publicSettled = true;
      listeners.clear();
      controller.signal.removeEventListener('abort', onAbort);
    });
    const cleanup = operation.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.active?.cleanup === cleanup) this.active = null;
    });
    const cancel = (reason?: unknown): void => {
      if (publicSettled || controller.signal.aborted) return;
      controller.abort(
        reason instanceof ImagePipelineCancelledError
          ? reason
          : new ImagePipelineCancelledError(normalizeCancellationReason(reason)),
      );
    };
    this.active = { cancel, cleanup };

    return {
      result,
      signal: controller.signal,
      cancel,
      progress(listener) {
        if (publicSettled) return () => undefined;
        listeners.add(listener);
        if (latestProgress) {
          try {
            listener(latestProgress);
          } catch (error) {
            reportListenerError(error);
          }
        }
        return () => listeners.delete(listener);
      },
    };
  }

  dispose(reason?: unknown): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const cancellationReason = normalizeCancellationReason(
      reason ?? { code: 'runtime-disposed' },
    );
    this.active?.cancel(cancellationReason);
    this.disposal = (async () => {
      await this.active?.cleanup;
      await this.options.dispose?.(cancellationReason);
    })();
    return this.disposal;
  }

  /**
   * Resolves after a cancelled or completed execution has released every live
   * artifact. Owners use this before admitting the next image.
   */
  whenIdle(): Promise<void> {
    return this.active?.cleanup ?? Promise.resolve();
  }

  private async ensurePrepared(context: RuntimeExecutionContext): Promise<void> {
    if (this.prepared) return;
    context.reportProgress({
      stage: 'runtime-prepare',
      operation: 'prepare-runtime',
    });
    if (!this.preparePromise) {
      this.preparePromise = Promise.resolve()
        .then(() => this.options.prepare?.(context))
        .then(() => {
          this.prepared = true;
        })
        .catch((error: unknown) => {
          this.preparePromise = null;
          throw error;
        });
    }
    await this.preparePromise;
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof ImagePipelineCancelledError
      ? signal.reason
      : new ImagePipelineCancelledError(
          normalizeCancellationReason(signal.reason),
        );
  }
}

function cloneBox(box: Rect): Rect {
  return { ...box };
}

function cloneQuad(
  quad: PipelineRecordRegion['quad'],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] | undefined {
  if (!quad) return undefined;
  return quad.map((point) => ({ ...point })) as [
    QuadPoint,
    QuadPoint,
    QuadPoint,
    QuadPoint,
  ];
}

export function createPipelineRecord(
  source: PipelineRecordSource,
  spec: WorkingCopySpec,
): PipelineRecord {
  if (!validateWorkingCopySpec(spec)) {
    throw new Error('工作副本规格结构无效');
  }
  const canonicalSpec = canonicalWorkingCopySpec(spec);
  const size = canonicalSpec.strategy === 'source-native' ? source.image : canonicalSpec.size;
  const transform: SourceToWorkingCopyTransform = canonicalSpec.strategy === 'source-native'
    ? { kind: 'identity' }
    : {
        kind: 'scale',
        scaleX: canonicalSpec.size.width / canonicalSpec.sourceSize.width,
        scaleY: canonicalSpec.size.height / canonicalSpec.sourceSize.height,
      };
  return cloneAndFreeze({
    schemaVersion: PIPELINE_RECORD_SCHEMA_VERSION,
    workingCopy: {
      width: size.width,
      height: size.height,
      spec: canonicalSpec,
      sourceToWorkingCopy: transform,
    },
    ocr: source.ocr.map((region, order) => ({
      id: region.id,
      order,
      box: cloneBox(region.box),
      quad: cloneQuad(region.quad),
      direction: region.direction,
      confidence: region.prob,
      text: region.sourceText,
    })),
    translations: source.ordered.map((region, order) => ({
      id: region.id,
      order,
      box: cloneBox(region.box),
      quad: cloneQuad(region.quad),
      direction: region.direction,
      sourceText: region.sourceText,
      translatedText: region.translatedText,
      translatedColumns: region.translatedColumns
        ? [...region.translatedColumns]
        : undefined,
    })),
  });
}

function isBox(value: unknown): value is Rect {
  return isRecord(value)
    && hasOnlyKeys(value, new Set(['x', 'y', 'width', 'height']))
    && isFiniteNonNegative(value.x)
    && isFiniteNonNegative(value.y)
    && isFiniteNonNegative(value.width)
    && isFiniteNonNegative(value.height);
}

function isQuad(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value)
    && value.length === 4
    && value.every((point) =>
      isRecord(point)
      && hasOnlyKeys(point, new Set(['x', 'y']))
      && typeof point.x === 'number'
      && Number.isFinite(point.x)
      && typeof point.y === 'number'
      && Number.isFinite(point.y))
  );
}

function isDirection(value: unknown): boolean {
  return value === undefined || value === 'h' || value === 'v';
}

function isOrderedBase(
  value: unknown,
  index: number,
): value is Record<string, unknown> {
  return isRecord(value)
    && hasOnlyKeys(
      value,
      new Set([
        'id',
        'order',
        'box',
        'quad',
        'direction',
        'confidence',
        'text',
        'sourceText',
        'translatedText',
        'translatedColumns',
      ]),
    )
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.order === index
    && isBox(value.box)
    && isQuad(value.quad)
    && isDirection(value.direction);
}

function isRecordEntries(value: Record<string, unknown>): boolean {
  if (
    !Array.isArray(value.ocr)
    || !Array.isArray(value.translations)
    || value.ocr.length > 10_000
    || value.translations.length > 10_000
  ) {
    return false;
  }
  return value.ocr.every((entry, index) =>
    isOrderedBase(entry, index)
    && hasOnlyKeys(
      entry,
      new Set(['id', 'order', 'box', 'quad', 'direction', 'confidence', 'text']),
    )
    && typeof entry.text === 'string'
    && entry.text.length <= 100_000
    && (
      entry.confidence === undefined
      || isFiniteNonNegative(entry.confidence)
    ))
    && value.translations.every((entry, index) =>
      isOrderedBase(entry, index)
      && hasOnlyKeys(
        entry,
        new Set([
          'id',
          'order',
          'box',
          'quad',
          'direction',
          'sourceText',
          'translatedText',
          'translatedColumns',
        ]),
      )
      && typeof entry.sourceText === 'string'
      && entry.sourceText.length <= 100_000
      && typeof entry.translatedText === 'string'
      && entry.translatedText.length <= 100_000
      && (
        entry.translatedColumns === undefined
        || (
          Array.isArray(entry.translatedColumns)
          && entry.translatedColumns.length <= 1_000
          && entry.translatedColumns.every(
            (column) =>
              typeof column === 'string'
              && column.length <= 100_000,
          )
        )
      ));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

export function isCurrentPipelineRecord(value: unknown): value is PipelineRecord {
  if (
    !isRecord(value)
    || !hasOnlyKeys(
      value,
      new Set(['schemaVersion', 'workingCopy', 'ocr', 'translations']),
    )
    || value.schemaVersion !== PIPELINE_RECORD_SCHEMA_VERSION
    || !isRecord(value.workingCopy)
    || !hasOnlyKeys(
      value.workingCopy,
      new Set(['width', 'height', 'spec', 'sourceToWorkingCopy']),
    )
    || !isPositiveInteger(value.workingCopy.width)
    || !isPositiveInteger(value.workingCopy.height)
    || !validateWorkingCopySpec(value.workingCopy.spec)
    || !isRecord(value.workingCopy.sourceToWorkingCopy)
  ) {
    return false;
  }
  const workingCopy = value.workingCopy as Record<string, unknown> & {
    width: number;
    height: number;
  };
  const spec = workingCopy.spec as WorkingCopySpec;
  const transform = workingCopy.sourceToWorkingCopy as Record<string, unknown>;
  const validTransform = spec.strategy === 'source-native'
    ? transform.kind === 'identity'
      && hasOnlyKeys(transform, new Set(['kind']))
    : workingCopy.width === spec.size.width
      && workingCopy.height === spec.size.height
      && transform.kind === 'scale'
      && hasOnlyKeys(transform, new Set(['kind', 'scaleX', 'scaleY']))
      && typeof transform.scaleX === 'number'
      && Number.isFinite(transform.scaleX)
      && transform.scaleX > 0
      && typeof transform.scaleY === 'number'
      && Number.isFinite(transform.scaleY)
      && transform.scaleY > 0
      && nearlyEqual(transform.scaleX, spec.size.width / spec.sourceSize.width)
      && nearlyEqual(transform.scaleY, spec.size.height / spec.sourceSize.height);
  return validTransform && isRecordEntries(value);
}

function isLegacyWebPipelineRecord(value: unknown): value is Record<string, unknown> & {
  schemaVersion: 1;
  image: ImageSize;
  ocr: PipelineOcrRecord[];
  translations: PipelineTranslationRecord[];
} {
  return isRecord(value)
    && value.schemaVersion === 1
    && isRecord(value.image)
    && isPositiveInteger(value.image.width)
    && isPositiveInteger(value.image.height)
    && isRecordEntries(value);
}

export function recoverPipelineRecord(
  value: unknown,
  legacyWorkingCopy?: WorkingCopySpec,
): PipelineRecord {
  if (isCurrentPipelineRecord(value)) {
    return cloneAndFreeze({
      schemaVersion: PIPELINE_RECORD_SCHEMA_VERSION,
      workingCopy: {
        width: value.workingCopy.width,
        height: value.workingCopy.height,
        spec: canonicalWorkingCopySpec(value.workingCopy.spec),
        sourceToWorkingCopy: value.workingCopy.sourceToWorkingCopy.kind === 'identity'
          ? { kind: 'identity' as const }
          : {
              kind: 'scale' as const,
              scaleX: value.workingCopy.sourceToWorkingCopy.scaleX,
              scaleY: value.workingCopy.sourceToWorkingCopy.scaleY,
            },
      },
      ocr: value.ocr.map((entry) => ({
        id: entry.id,
        order: entry.order,
        box: cloneBox(entry.box),
        quad: cloneQuad(entry.quad),
        direction: entry.direction,
        confidence: entry.confidence,
        text: entry.text,
      })),
      translations: value.translations.map((entry) => ({
        id: entry.id,
        order: entry.order,
        box: cloneBox(entry.box),
        quad: cloneQuad(entry.quad),
        direction: entry.direction,
        sourceText: entry.sourceText,
        translatedText: entry.translatedText,
        translatedColumns: entry.translatedColumns
          ? [...entry.translatedColumns]
          : undefined,
      })),
    });
  }
  if (isLegacyWebPipelineRecord(value)) {
    if (!legacyWorkingCopy || !validateWorkingCopySpec(legacyWorkingCopy)) {
      throw new Error('恢复旧版流水线记录需要明确的工作副本几何');
    }
    const canonicalSpec = canonicalWorkingCopySpec(legacyWorkingCopy);
    const workingSize = canonicalSpec.strategy === 'source-native'
      ? value.image
      : canonicalSpec.size;
    if (
      workingSize.width !== value.image.width
      || workingSize.height !== value.image.height
    ) {
      throw new Error('旧版流水线记录与工作副本几何不一致');
    }
    return cloneAndFreeze({
      schemaVersion: PIPELINE_RECORD_SCHEMA_VERSION,
      workingCopy: {
        width: value.image.width,
        height: value.image.height,
        spec: canonicalSpec,
        sourceToWorkingCopy: canonicalSpec.strategy === 'source-native'
          ? { kind: 'identity' as const }
          : {
              kind: 'scale' as const,
              scaleX: canonicalSpec.size.width / canonicalSpec.sourceSize.width,
              scaleY: canonicalSpec.size.height / canonicalSpec.sourceSize.height,
            },
      },
      ocr: value.ocr,
      translations: value.translations,
    });
  }
  if (
    isRecord(value)
    && value.schemaVersion === PIPELINE_RECORD_SCHEMA_VERSION
  ) {
    throw new Error('流水线处理记录结构无效');
  }
  if (isRecord(value) && typeof value.schemaVersion === 'number') {
    throw new Error(`不支持的流水线处理记录版本: ${value.schemaVersion}`);
  }
  throw new Error('流水线处理记录结构无效');
}

export function isPipelineRecord(value: unknown): boolean {
  try {
    recoverPipelineRecord(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the sole owner of pipeline admission, retries, cancellation,
 * records, encoding, and model/artifact disposal for a host.
 */
export function createImagePipeline(
  dependencies: ImagePipelineDependencies,
): ImagePipeline {
  let activeExecution: ImagePipelineExecution | null = null;
  const runtime = new ImagePipelineRuntime<PipelineArtifacts>({
    async prepare() {
      if (dependencies.fontSource) {
        registerTypesetFonts(dependencies.platform, dependencies.fontSource);
        await dependencies.platform.waitForFonts();
      }
    },
    async execute(request, context) {
      const execution = activeExecution;
      if (!execution) {
        throw new Error('流水线执行 capability 不可用');
      }
      const preparedSource = dependencies.platform.prepareSource
        ? await dependencies.platform.prepareSource(
            request.source,
            request.workingCopy,
          )
        : request.source;
      const source = preparedSource instanceof File
        ? preparedSource
        : new File([preparedSource], 'source-image', {
            type: preparedSource.type,
          });
      const textTranslator: TextTranslator = {
        translateRegions(translationRequest) {
          return context.runOperation(
            {
              stage: 'translate',
              operation: 'translate-regions',
            },
            () => execution.textTranslator.translateRegions(
              translationRequest,
            ),
          );
        },
      };
      const artifacts = await runPipeline(
        source,
        request.config,
        context.reportProgress,
        {
          signal: context.signal,
          platform: dependencies.platform,
          modelRuntime: dependencies.modelRuntime,
          textTranslator,
          observer: dependencies.observer,
          detectionFallbackStrategy:
            dependencies.detectionFallbackStrategy,
        },
      );
      return {
        status: hasTranslatableText({
          ordered: artifacts.stageRegions.ordered,
        })
          ? 'completed'
          : 'no-translatable-text',
        artifacts,
      };
    },
    async finalize(output, request) {
      const finalizeStartedAt = performance.now();
      const image = await canvasToPngBlob(output.artifacts.resultCanvas);
      const debug = request.config.typesetDebug
        && output.artifacts.debugOriginalCanvas
        ? await canvasToPngBlob(output.artifacts.debugOriginalCanvas)
        : undefined;
      output.artifacts.stageTimings.push({
        stage: 'finalize',
        label: '生成结果图片',
        durationMs: performance.now() - finalizeStartedAt,
      });
      return {
        status: output.status,
        image,
        debug,
        record: createPipelineRecord({
          image: {
            width: output.artifacts.original.naturalWidth,
            height: output.artifacts.original.naturalHeight,
          },
          ocr: output.artifacts.stageRegions.ocr,
          ordered: output.artifacts.stageRegions.ordered,
        }, request.workingCopy),
        diagnostics: {
          summary: summarizePipelineArtifacts(output.artifacts),
        },
      };
    },
    release(output) {
      disposePipelineArtifacts(output.artifacts);
    },
    releaseFailure(error) {
      if (error instanceof PipelineStageError) {
        disposePipelineArtifacts(error.artifacts);
      }
    },
    dispose() {
      return dependencies.modelRuntime.dispose();
    },
  });

  return Object.freeze({
    run(request: ImagePipelineRequest, execution: ImagePipelineExecution) {
      activeExecution = execution;
      let task: TranslationTask<PipelineProgress, ImagePipelineResult>;
      try {
        task = runtime.run(request);
      } catch (error) {
        activeExecution = null;
        throw error;
      }
      task.result.then(
        () => {
          activeExecution = null;
        },
        () => {
          activeExecution = null;
        },
      );
      return task;
    },
    whenIdle() {
      return runtime.whenIdle();
    },
    dispose(reason?: unknown) {
      activeExecution = null;
      return runtime.dispose(reason);
    },
  });
}
