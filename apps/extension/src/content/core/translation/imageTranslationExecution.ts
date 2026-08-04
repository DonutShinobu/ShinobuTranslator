import type { PipelineConfig, PipelineProgress } from '@shinobu/image-pipeline';
import type {
  LocalPipelineArtifactSummary,
  LocalPipelineResult,
} from '@shinobu/image-pipeline/protocol';
import { base64ToBlob, blobToBase64 } from '@shinobu/image-pipeline/protocol';
import type { TranslationFailure, TranslationTask } from '@shinobu/translator-core';
import {
  TranslationCancelledError,
  TranslationExecutionError,
  createTranslatorCore,
} from '@shinobu/translator-core';
import type { TranslationReferenceContext } from '@shinobu/text-translation';
import {
  sanitizeDiagnosticUrl,
  toDiagnosticError,
} from '@shinobu/diagnostics';
import {
  type ExtensionExecutionSnapshot,
  type ExecutionDisplayPreferences,
  type WholeImageExecutionPreparation,
} from '../../../shared/extensionControl';
import type {
  CloudImageTranslateMetadata,
  RuntimeErrorDetail,
} from '../../../shared/messages';
import { sendRuntimeMessage } from '../../../shared/messages';
import {
  createDiagnosticRunId,
  emitDiagnosticLog,
  emitDiagnosticLogAsync,
} from '../../../shared/diagnosticLogClient';
import {
  sanitizePipelineConfig,
} from '../../../shared/diagnosticSettings';
import { getStageLabel, inferFileExtension, toErrorMessage } from '../utils';
import { runLocalPipeline, type RunLocalPipeline } from './localPipelineClient';
import {
  createExecutionPreparationClient,
  type PrepareImageTranslationExecution,
} from './executionPreparationClient';

export type ImageTranslationExecutionKind = 'local-pipeline' | 'whole-image';

export type ImageTranslationSource =
  | {
      kind: 'remote-image';
      url: string;
      referrerPolicy?: ReferrerPolicy;
    }
  | {
      kind: 'prepared-file';
      file: File;
    };

export type ImageTranslationExecutionRequest = {
  source: ImageTranslationSource;
  translationContext?: TranslationReferenceContext;
  allowedKinds?: readonly ImageTranslationExecutionKind[];
};

export type ImageTranslationDisplayPreferences = {
  [K in keyof ExecutionDisplayPreferences]: ExecutionDisplayPreferences[K];
};

export type AcquiredImageTranslationSource = {
  file: File;
  blob: Blob;
};

export type ImageTranslationExecutionProgress =
  | {
      phase: 'preparing';
      operation: 'prepare-execution' | 'acquire-source';
    }
  | {
      phase: 'preparing';
      operation: 'source-ready';
      source: AcquiredImageTranslationSource;
    }
  | {
      phase: 'executing';
      execution:
        | {
            kind: 'local-pipeline';
            progress: PipelineProgress;
          }
        | {
            kind: 'whole-image';
            provider: WholeImageTranslationProvider;
            modelLabel: string;
            operation: 'generate';
          };
    }
  | {
      phase: 'finalizing';
      operation: 'collect-artifacts';
    };

type ImageTranslationExecutionResultBase = {
  source: AcquiredImageTranslationSource;
  elapsedMs: number;
  display: ImageTranslationDisplayPreferences;
  diagnosticRunId?: string;
};

export type LocalPipelineImageTranslationResult = ImageTranslationExecutionResultBase & {
  kind: 'local-pipeline';
  status: LocalPipelineResult['status'];
  image: Blob;
  debug?: Blob;
  summary: LocalPipelineArtifactSummary;
  record: LocalPipelineResult['record'];
};

export type WholeImageTranslationProvider = 'gemini-app' | 'gemini-api';

export type WholeImageTranslationResult = ImageTranslationExecutionResultBase & {
  kind: 'whole-image';
  status: 'completed';
  provider: WholeImageTranslationProvider;
  image: Blob;
  metadata: CloudImageTranslateMetadata;
};

export type ImageTranslationExecutionResult =
  | LocalPipelineImageTranslationResult
  | WholeImageTranslationResult;

export interface ImageTranslationExecutionModule {
  start(
    request: ImageTranslationExecutionRequest,
  ): TranslationTask<ImageTranslationExecutionProgress, ImageTranslationExecutionResult>;
}

export type WholeImageTranslationPortResult = {
  image: Blob;
  metadata: CloudImageTranslateMetadata;
};

export type RunWholeImageTranslation = (
  file: File,
  options: {
    signal: AbortSignal;
    preparation: WholeImageExecutionPreparation;
    diagnosticRunId?: string;
  },
) => Promise<WholeImageTranslationPortResult>;

export type DownloadImageForTranslation = (
  source: Extract<ImageTranslationSource, { kind: 'remote-image' }>,
  options: { signal: AbortSignal; diagnosticRunId?: string },
) => Promise<AcquiredImageTranslationSource>;

export type ImageTranslationExecutionDependencies = {
  sendMessage?: typeof sendRuntimeMessage;
  prepareExecution?: PrepareImageTranslationExecution;
  downloadImage?: DownloadImageForTranslation;
  runLocalPipeline?: RunLocalPipeline;
  runWholeImageTranslation?: RunWholeImageTranslation;
  createDiagnosticRunId?: (prefix: string) => string;
  now?: () => number;
};

export class ImageTranslationExecutionError extends TranslationExecutionError {
  constructor(
    failure: TranslationFailure,
    cause?: unknown,
    readonly diagnosticRunId?: string,
    readonly detail?: RuntimeErrorDetail,
  ) {
    super(failure, cause);
    this.name = 'ImageTranslationExecutionError';
  }
}

export class ImageTranslationExecutionKindNotAllowedError extends ImageTranslationExecutionError {

  constructor(readonly kind: ImageTranslationExecutionKind) {
    const message = kind === 'whole-image'
      ? '当前入口不支持 Nano Banana 整图翻译'
      : '当前入口不支持本地图片翻译流水线';
    super({
      code: 'IMAGE_TRANSLATION_EXECUTION_KIND_NOT_ALLOWED',
      scope: 'runtime',
      retryable: false,
      messageKey: message,
    });
    this.name = 'ImageTranslationExecutionKindNotAllowedError';
  }
}

export class WholeImageTranslationError extends ImageTranslationExecutionError {
  constructor(
    message: string,
    detail?: RuntimeErrorDetail,
    diagnosticRunId?: string,
    cause?: unknown,
  ) {
    super({
      code: 'WHOLE_IMAGE_TRANSLATION_FAILED',
      scope: 'runtime',
      retryable: true,
      messageKey: message,
    }, cause, diagnosticRunId, detail);
    this.name = 'WholeImageTranslationError';
  }
}

export function isRuntimeImageTranslationFailure(error: unknown): boolean {
  return error instanceof TranslationExecutionError
    && error.failure.scope === 'runtime';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function assertKindAllowed(
  kind: ImageTranslationExecutionKind,
  allowedKinds: readonly ImageTranslationExecutionKind[] | undefined,
): void {
  if (allowedKinds && !allowedKinds.includes(kind)) {
    throw new ImageTranslationExecutionKindNotAllowedError(kind);
  }
}

function preparedSource(file: File): AcquiredImageTranslationSource {
  return { file, blob: file };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type ExecutionFailureDefaults = {
  code: string;
  scope: TranslationFailure['scope'];
  retryable: boolean;
};

function inferredFailureScope(
  error: unknown,
  fallback: TranslationFailure['scope'],
): TranslationFailure['scope'] {
  if (isRecord(error) && (error.scope === 'image' || error.scope === 'runtime')) {
    return error.scope;
  }
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  return (
    code === 'PIPELINE_HOST_UNAVAILABLE'
    || code === 'PIPELINE_HOST_CREATE_FAILED'
    || code === 'PIPELINE_HOST_DISCONNECTED'
    || code === 'TRANSFER_PROTOCOL_ERROR'
    || code === 'RUNTIME_BUSY'
    || code === 'WORKER_BOOTSTRAP_FAILED'
  ) ? 'runtime' : fallback;
}

function normalizeExecutionError(
  error: unknown,
  defaults: ExecutionFailureDefaults,
  diagnosticRunId?: string,
): ImageTranslationExecutionError | TranslationCancelledError {
  if (error instanceof TranslationCancelledError) return error;
  if (error instanceof WholeImageTranslationError) {
    return diagnosticRunId && !error.diagnosticRunId
      ? new WholeImageTranslationError(
          error.message,
          error.detail,
          diagnosticRunId,
          error,
        )
      : error;
  }
  if (error instanceof ImageTranslationExecutionError) return error;
  if (error instanceof TranslationExecutionError) {
    return new ImageTranslationExecutionError(
      error.failure,
      error,
      diagnosticRunId,
    );
  }

  const record = isRecord(error) ? error : undefined;
  const message = toErrorMessage(error);
  return new ImageTranslationExecutionError({
    code: typeof record?.code === 'string' ? record.code : defaults.code,
    stage: typeof record?.stage === 'string' ? record.stage : undefined,
    scope: inferredFailureScope(error, defaults.scope),
    retryable: typeof record?.retryable === 'boolean'
      ? record.retryable
      : defaults.retryable,
    messageKey: typeof record?.messageKey === 'string'
      ? record.messageKey
      : message,
    diagnostics: isRecord(record?.diagnostics)
      ? record.diagnostics
      : undefined,
  }, error, diagnosticRunId);
}

function getPipelineArtifactsFromError(error: unknown): LocalPipelineArtifactSummary | null {
  if (!isRecord(error) || !('artifacts' in error)) return null;
  const artifacts = error.artifacts;
  if (!isRecord(artifacts) || !Array.isArray(artifacts.stageTimings)) return null;
  return artifacts as LocalPipelineArtifactSummary;
}

function toFileDiagnosticData(file: File): Record<string, unknown> {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

function toPipelineArtifactsDiagnosticData(
  artifacts: LocalPipelineArtifactSummary,
): Record<string, unknown> {
  return {
    image: artifacts.image,
    detectedRegionCount: artifacts.detectedRegionCount,
    stageTimings: artifacts.stageTimings,
    runtimeStages: artifacts.runtimeStages,
    translationDebug: artifacts.translationDebug,
    ocrDebug: artifacts.ocrDebug,
    ocrPostFilterDebug: artifacts.ocrPostFilterDebug,
    typesetDebug: artifacts.typesetDebug,
  };
}

function currentPageDiagnosticUrl(): string {
  return typeof window === 'undefined' ? '' : sanitizeDiagnosticUrl(window.location.href);
}

function createRuntimeImageDownloader(
  sendMessage: typeof sendRuntimeMessage,
): DownloadImageForTranslation {
  return async (source, { signal, diagnosticRunId }) => {
    throwIfAborted(signal);
    const startedAt = performance.now();
    if (diagnosticRunId) {
      await emitDiagnosticLogAsync({
        runId: diagnosticRunId,
        level: 'info',
        category: 'image.io',
        source: { context: 'content', module: 'imageTranslationExecution.ts' },
        message: '开始下载原图',
        data: {
          originalUrl: sanitizeDiagnosticUrl(source.url),
          referrerPolicy: source.referrerPolicy,
        },
      });
    }
    try {
      const response = await sendMessage({
        type: 'mt:download-image',
        imageUrl: source.url,
        ...(source.referrerPolicy !== undefined
          ? { referrerPolicy: source.referrerPolicy }
          : {}),
      });
      throwIfAborted(signal);
      if (!response.ok || response.type !== 'mt:download-image') {
        throw new Error(response.ok ? '下载图片失败' : response.error);
      }
      const blob = base64ToBlob(response.base64, response.contentType);
      const suffix = inferFileExtension(response.contentType, response.sourceUrl);
      if (diagnosticRunId) {
        emitDiagnosticLog({
          runId: diagnosticRunId,
          level: 'info',
          category: 'image.io',
          source: { context: 'content', module: 'imageTranslationExecution.ts' },
          message: '原图下载完成',
          data: {
            originalUrl: sanitizeDiagnosticUrl(source.url),
            sourceUrl: sanitizeDiagnosticUrl(response.sourceUrl),
            contentType: response.contentType,
            referrerPolicy: source.referrerPolicy,
            blobSize: blob.size,
            base64Length: response.base64.length,
            durationMs: performance.now() - startedAt,
          },
        });
      }
      return {
        blob,
        file: new File([blob], `source.${suffix}`, {
          type: blob.type || 'image/jpeg',
        }),
      };
    } catch (error) {
      if (diagnosticRunId) {
        emitDiagnosticLog({
          runId: diagnosticRunId,
          level: 'error',
          category: 'image.io',
          source: { context: 'content', module: 'imageTranslationExecution.ts' },
          message: `原图下载失败：${toErrorMessage(error)}`,
          data: {
            originalUrl: sanitizeDiagnosticUrl(source.url),
            referrerPolicy: source.referrerPolicy,
            durationMs: performance.now() - startedAt,
          },
          error: toDiagnosticError(error),
        });
      }
      throw error;
    }
  };
}

function createRuntimeWholeImageTranslator(
  sendMessage: typeof sendRuntimeMessage,
): RunWholeImageTranslation {
  return async (file, { signal, preparation, diagnosticRunId }) => {
    throwIfAborted(signal);
    const image = {
      base64: await blobToBase64(file),
      contentType: file.type || 'image/png',
      filename: file.name || 'source.png',
    };
    throwIfAborted(signal);
    const response = preparation.provider === 'gemini-api'
      ? await sendMessage({
          type: 'mt:gemini-api-image-translate',
          image,
          preparation,
          diagnosticRunId,
        })
      : await sendMessage({
          type: 'mt:gemini-app-image-translate',
          image,
          preparation,
          diagnosticRunId,
        });
    throwIfAborted(signal);
    if (!response.ok) {
      throw new WholeImageTranslationError(response.error, response.errorDetail);
    }
    if (
      response.type !== 'mt:gemini-app-image-translate'
      && response.type !== 'mt:gemini-api-image-translate'
    ) {
      throw new WholeImageTranslationError('Nano Banana 翻译失败');
    }
    return {
      image: base64ToBlob(response.base64, response.contentType),
      metadata: response.metadata,
    };
  };
}

export function createImageTranslationExecutionModule(
  dependencies: ImageTranslationExecutionDependencies = {},
): ImageTranslationExecutionModule {
  const sendMessage = dependencies.sendMessage ?? sendRuntimeMessage;
  const prepareExecution = dependencies.prepareExecution
    ?? createExecutionPreparationClient();
  const downloadImage = dependencies.downloadImage ?? createRuntimeImageDownloader(sendMessage);
  const executeLocalPipeline = dependencies.runLocalPipeline ?? runLocalPipeline;
  const executeWholeImage = dependencies.runWholeImageTranslation
    ?? createRuntimeWholeImageTranslator(sendMessage);
  const now = dependencies.now ?? (() => performance.now());
  const createRunId = dependencies.createDiagnosticRunId ?? createDiagnosticRunId;

  const core = createTranslatorCore<
    ImageTranslationExecutionRequest,
    undefined,
    ImageTranslationExecutionProgress,
    ImageTranslationExecutionResult
  >(async ({ input: request }, { signal, reportProgress }) => {
    const startedAt = now();
    reportProgress({ phase: 'preparing', operation: 'prepare-execution' });
    let preparation: ExtensionExecutionSnapshot;
    let kind: ImageTranslationExecutionKind;
    try {
      preparation = await prepareExecution(signal);
      throwIfAborted(signal);
      kind = preparation.kind;
      assertKindAllowed(kind, request.allowedKinds);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw normalizeExecutionError(error, {
        code: 'IMAGE_TRANSLATION_SETTINGS_INVALID',
        scope: 'runtime',
        retryable: false,
      });
    }
    const diagnosticRunId = preparation.diagnosticLogEnabled
      ? createRunId('run')
      : undefined;

    reportProgress({ phase: 'preparing', operation: 'acquire-source' });
    let source: AcquiredImageTranslationSource;
    try {
      source = request.source.kind === 'prepared-file'
        ? preparedSource(request.source.file)
        : await downloadImage(request.source, { signal, diagnosticRunId });
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw normalizeExecutionError(error, {
        code: 'IMAGE_TRANSLATION_SOURCE_ACQUISITION_FAILED',
        scope: 'image',
        retryable: true,
      }, diagnosticRunId);
    }
    reportProgress({ phase: 'preparing', operation: 'source-ready', source });

    const config: PipelineConfig | undefined = preparation.pipelineConfig
      ? { ...preparation.pipelineConfig }
      : undefined;
    if (config && config.translator === 'llm' && request.translationContext) {
      config.translationContext = request.translationContext;
    }
    if (config && diagnosticRunId) config.diagnosticRunId = diagnosticRunId;
    if (diagnosticRunId) {
      await emitDiagnosticLogAsync({
        runId: diagnosticRunId,
        level: 'info',
        category: 'app.config',
        source: { context: 'content', module: 'imageTranslationExecution.ts' },
        message: '开始图片翻译执行',
        data: {
          runStatus: 'running',
          executionKind: kind,
          settings: preparation.diagnosticSettings,
          pipelineConfig: config ? sanitizePipelineConfig(config) : undefined,
          pageUrl: currentPageDiagnosticUrl(),
          originalUrl: request.source.kind === 'remote-image'
            ? sanitizeDiagnosticUrl(request.source.url)
            : undefined,
          file: toFileDiagnosticData(source.file),
        },
      });
    }

    try {
      if (kind === 'whole-image') {
        const wholeImage = preparation.wholeImage;
        if (!wholeImage) throw new Error('整图翻译执行快照不完整');
        const provider: WholeImageTranslationProvider = wholeImage.provider;
        reportProgress({
          phase: 'executing',
          execution: {
            kind,
            provider,
            modelLabel: wholeImage.modelLabel,
            operation: 'generate',
          },
        });
        const result = await executeWholeImage(source.file, {
          signal,
          preparation: wholeImage,
          diagnosticRunId,
        });
        throwIfAborted(signal);
        reportProgress({ phase: 'finalizing', operation: 'collect-artifacts' });
        throwIfAborted(signal);
        if (diagnosticRunId) {
          emitDiagnosticLog({
            runId: diagnosticRunId,
            level: 'info',
            category: 'pipeline.stage',
            source: { context: 'content', module: 'imageTranslationExecution.ts' },
            message: 'Nano Banana 全图翻译完成',
            data: { runStatus: 'success', durationMs: now() - startedAt },
          });
        }
        return {
          kind,
          status: 'completed',
          provider,
          image: result.image,
          metadata: result.metadata,
          source,
          display: preparation.display,
          diagnosticRunId,
          elapsedMs: now() - startedAt,
        };
      }

      const result = await executeLocalPipeline(
        source.file,
        config!,
        (progress) => {
          if (diagnosticRunId) {
            emitDiagnosticLog({
              runId: diagnosticRunId,
              level: 'info',
              category: 'pipeline.stage',
              source: { context: 'content', module: 'imageTranslationExecution.ts' },
              message: `进入阶段：${getStageLabel(progress.stage)}`,
              data: { stage: progress.stage, detail: progress.detail },
            });
          }
          reportProgress({
            phase: 'executing',
            execution: { kind, progress },
          });
        },
        { signal },
      );
      throwIfAborted(signal);
      reportProgress({ phase: 'finalizing', operation: 'collect-artifacts' });
      throwIfAborted(signal);
      if (diagnosticRunId) {
        emitDiagnosticLog({
          runId: diagnosticRunId,
          level: 'info',
          category: 'pipeline.typeset',
          source: { context: 'content', module: 'imageTranslationExecution.ts' },
          message: '本地 pipeline artifacts 已汇总',
          data: toPipelineArtifactsDiagnosticData(result.summary),
        });
        emitDiagnosticLog({
          runId: diagnosticRunId,
          level: 'info',
          category: 'pipeline.stage',
          source: { context: 'content', module: 'imageTranslationExecution.ts' },
          message: '图片翻译执行完成',
          data: { runStatus: 'success', durationMs: now() - startedAt },
        });
      }
      return {
        kind,
        status: result.status,
        image: result.result,
        debug: result.debug,
        summary: result.summary,
        record: result.record,
        source,
        display: preparation.display,
        diagnosticRunId,
        elapsedMs: now() - startedAt,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const normalizedError = normalizeExecutionError(error, {
        code: kind === 'whole-image'
          ? 'WHOLE_IMAGE_TRANSLATION_FAILED'
          : 'LOCAL_PIPELINE_EXECUTION_FAILED',
        scope: kind === 'whole-image' ? 'runtime' : 'image',
        retryable: true,
      }, diagnosticRunId);
      if (diagnosticRunId) {
        const artifacts = getPipelineArtifactsFromError(error);
        const diagnosticError = toDiagnosticError(normalizedError);
        await emitDiagnosticLogAsync({
          runId: diagnosticRunId,
          level: 'error',
          category: 'error',
          source: { context: 'content', module: 'imageTranslationExecution.ts' },
          message: `图片翻译执行失败：${diagnosticError.message}`,
          data: {
            runStatus: 'failed',
            durationMs: now() - startedAt,
            artifacts: artifacts
              ? toPipelineArtifactsDiagnosticData(artifacts)
              : undefined,
          },
          error: diagnosticError,
        });
      }
      throw normalizedError;
    }
  });

  return {
    start(request) {
      return core.run({ input: request, config: undefined });
    },
  };
}
