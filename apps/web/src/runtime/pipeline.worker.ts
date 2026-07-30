import {
  attachWorkerTranslatorHost,
  createDirectChatCompletionRequester,
  DirectChatCompletionError,
  type WorkerHostEndpoint,
} from '@shinobu/browser-runtime';
import {
  ImagePipelineCancelledError,
  ImagePipelineExecutionError,
  ImagePipelineRuntime,
  hasTranslatableText,
  type NormalizedWorkingCopySpec,
  type PipelineConfig,
  type PipelineProgress,
} from '@shinobu/image-pipeline';
import { runPipeline, PipelineStageError } from '../../../../src/pipeline/orchestrator';
import { disposePipelineArtifacts } from '../../../../src/pipeline/resources';
import { canvasToPngBlob } from '../../../../src/shared/blobCodec';
import {
  serializePipelineError,
  summarizePipelineArtifacts,
} from '../../../../src/shared/localPipelineProtocol';
import type {
  PipelineArtifacts,
  PipelineConfig as LegacyPipelineConfig,
} from '../../../../src/types';
import type { TextTranslationTransport } from '../../../../src/translators/transport';
import {
  configureModelAssetSource,
  disposeAllModelSessions,
} from '../../../../src/runtime/modelRegistry';
import { configureOnnxWorkerBootstrap } from '../../../../src/runtime/onnxWorkerBridge';
import { registerTypesetFonts } from '../../../../src/pipeline/typeset/fontRuntime';
import onnxWorkerScriptUrl from '../../../../src/workers/onnx-worker.ts?worker&url';
import {
  createNormalizedWorkingFile,
  createOffscreenPlatform,
} from './offscreenPlatform';
import { createInstalledModelAssetSource } from './installedModelSource';
import type {
  WebPipelineInput,
  WebPipelineResult,
  WebPipelineRuntimeCapabilities,
  WebWorkerPipelineConfig,
} from './webPipeline';
import { createWebPipelineRecord } from '../domain/pipelineRecord';
import { installTrustedTypesPolicy } from './trustedTypes';

installTrustedTypesPolicy();
configureOnnxWorkerBootstrap({
  scriptUrl: onnxWorkerScriptUrl,
});

const platform = createOffscreenPlatform();
const directChatCompletion = createDirectChatCompletionRequester({
  maxRetries: 0,
});
const translationTransport: TextTranslationTransport = {
  async requestChatCompletion(request) {
    if (request.proxyConfig.authMode !== 'api_key') {
      throw new DirectChatCompletionError('Web 版本当前仅支持 API Key 认证');
    }
    const apiKey = request.apiKey?.trim() ?? '';
    if (!apiKey) {
      throw new DirectChatCompletionError('LLM 模式需要填写 API Key');
    }
    const baseUrl = request.proxyConfig.baseUrl.trim().replace(/\/+$/u, '');
    if (!baseUrl) {
      throw new DirectChatCompletionError('LLM Base URL 不能为空');
    }
    return await directChatCompletion.request({
      endpoint: `${baseUrl}/chat/completions`,
      apiKey,
      body: request.providerBody ?? request.body,
      signal: request.signal,
    }) as Awaited<ReturnType<TextTranslationTransport['requestChatCompletion']>>;
  },
  translatePlain() {
    return Promise.reject(new DirectChatCompletionError(
      'Web 版本当前不支持 Google Web 文本翻译',
    ));
  },
};
const modelSourceResource = createInstalledModelAssetSource();
let fontReady: Promise<void> | null = null;
let runtime: ImagePipelineRuntime<PipelineArtifacts> | null = null;
let runtimeApiKey: string | null = null;

function ensureFonts(): Promise<void> {
  if (!fontReady) {
    registerTypesetFonts(platform, (path) => `/${path}`);
    fontReady = platform.waitForFonts();
  }
  return fontReady;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
    && error.name === 'AbortError'
  ) || Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'TASK_CANCELLED'
  );
}

function normalizeWorkingCopy(
  input: WebPipelineInput,
): NormalizedWorkingCopySpec {
  if ('strategy' in input.workingCopy) return input.workingCopy;
  return {
    strategy: 'normalized',
    sourceSize: {
      width: input.workingCopy.width,
      height: input.workingCopy.height,
    },
    size: {
      width: input.workingCopy.width,
      height: input.workingCopy.height,
    },
    imageOrientation: 'from-image',
    background: '#ffffff',
  };
}

function toLegacyConfig(
  config: PipelineConfig,
  capabilities: WebPipelineRuntimeCapabilities,
): LegacyPipelineConfig {
  return {
    ...config,
    llmApiKey: capabilities.textTranslation.apiKey,
  };
}

function createRuntime(
  capabilities: WebPipelineRuntimeCapabilities,
): ImagePipelineRuntime<PipelineArtifacts> {
  return new ImagePipelineRuntime({
    capabilities: {
      providerExecution: capabilities.providerExecution,
    },
    async prepare() {
      const installed = await modelSourceResource;
      configureModelAssetSource(installed.source);
      await ensureFonts();
    },
    async execute(request, context) {
      const workingCopy = request.workingCopy;
      if (workingCopy.strategy !== 'normalized') {
        throw new Error('Web Worker 只接受 normalized 工作副本');
      }
      const source = request.source instanceof File
        ? request.source
        : new File([request.source], 'source-image', {
            type: request.source.type,
          });
      const file = await createNormalizedWorkingFile(
        source,
        workingCopy.size,
      );
      if (context.signal.aborted) throw context.signal.reason;
      const retryingTranslationTransport: TextTranslationTransport = {
        requestChatCompletion(translationRequest) {
          return context.runOperation(
            {
              stage: 'translate',
              operation: 'request-chat-completion',
            },
            () => translationTransport.requestChatCompletion(translationRequest),
          );
        },
        translatePlain(translationRequest) {
          return context.runOperation(
            {
              stage: 'translate',
              operation: 'translate-plain',
            },
            () => translationTransport.translatePlain(translationRequest),
          );
        },
      };
      const artifacts = await runPipeline(
        file,
        toLegacyConfig(request.config, capabilities),
        (progress) => context.reportProgress({
          stage: progress.stage,
          operation: progress.stage,
          detail: progress.detail,
        }),
        {
          signal: context.signal,
          platform,
          translationTransport: retryingTranslationTransport,
          runtimeCapabilities: context.capabilities,
        },
      );
      return {
        status: hasTranslatableText({ ordered: artifacts.stageRegions.ordered })
          ? 'completed' as const
          : 'no-translatable-text' as const,
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
        providerReports: output.artifacts.providerReports,
        record: createWebPipelineRecord(
          output.artifacts,
          request.workingCopy,
        ),
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
    async dispose() {
      await disposeAllModelSessions();
      (await modelSourceResource).dispose();
      fontReady = null;
    },
  });
}

function runtimeFor(
  capabilities: WebPipelineRuntimeCapabilities,
): ImagePipelineRuntime<PipelineArtifacts> {
  const apiKey = capabilities.textTranslation.apiKey;
  if (!runtime) {
    runtime = createRuntime(capabilities);
    runtimeApiKey = apiKey;
  } else if (runtimeApiKey !== apiKey) {
    throw new Error('Worker runtime capability 在生命周期内发生变化');
  }
  return runtime;
}

attachWorkerTranslatorHost<
  WebPipelineInput,
  WebWorkerPipelineConfig,
  PipelineProgress,
  WebPipelineResult
>({
  endpoint: globalThis as unknown as WorkerHostEndpoint,
  async execute({ input, config }, { signal, reportProgress }) {
    const imageRuntime = runtimeFor(config.capabilities);
    const task = imageRuntime.run({
      source: input.file,
      config: config.pipeline,
      workingCopy: normalizeWorkingCopy(input),
    });
    const stopProgress = task.progress(reportProgress);
    const cancel = (): void => {
      const reason = signal.reason instanceof ImagePipelineCancelledError
        ? signal.reason.reason
        : signal.reason
          && typeof signal.reason === 'object'
          && 'reason' in signal.reason
          && signal.reason.reason
          && typeof signal.reason.reason === 'object'
          && 'code' in signal.reason.reason
          && 'messageKey' in signal.reason.reason
            ? signal.reason.reason
            : {
                code: 'unknown',
                messageKey: 'pipeline.cancelled.unknown',
                diagnosticSummary: signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason ?? ''),
              };
      task.cancel(reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result = await task.result;
      const summary = result.diagnostics?.summary;
      return {
        ...result,
        summary: summary as WebPipelineResult['summary'],
      };
    } finally {
      signal.removeEventListener('abort', cancel);
      stopProgress();
      await imageRuntime.whenIdle();
    }
  },
  serializeError(error) {
    if (error instanceof ImagePipelineExecutionError) {
      return {
        name: error.name,
        message: error.message,
        code: error.failure.code,
        stage: error.failure.stage,
        scope: error.failure.scope,
        retryable: error.failure.retryable,
        messageKey: error.failure.messageKey,
        diagnostics: error.failure.diagnostics,
      };
    }
    return serializePipelineError(
      error,
      isAbortError(error) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED',
    );
  },
  async dispose(reason) {
    if (!runtime) return;
    const cancellation = (
      reason
      && typeof reason === 'object'
      && 'code' in reason
      && 'messageKey' in reason
    ) ? reason : {
      code: 'runtime-disposed',
      messageKey: 'pipeline.cancelled.runtimeDisposed',
      diagnosticSummary: reason instanceof Error
        ? reason.message
        : typeof reason === 'string' && reason
          ? reason
          : undefined,
    };
    await runtime.dispose(cancellation);
    runtime = null;
    runtimeApiKey = null;
  },
});
