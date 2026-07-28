import {
  attachWorkerTranslatorHost,
  type WorkerHostEndpoint,
} from '@shinobu/browser-runtime';
import { runPipeline, PipelineStageError } from '../../../../src/pipeline/orchestrator';
import { disposePipelineArtifacts } from '../../../../src/pipeline/resources';
import { canvasToPngBlob } from '../../../../src/shared/blobCodec';
import {
  serializePipelineError,
  summarizePipelineArtifacts,
} from '../../../../src/shared/localPipelineProtocol';
import type {
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
} from '../../../../src/types';
import { createDirectTextTranslationTransport } from '../../../../src/translators/transport';
import { configureModelAssetSource } from '../../../../src/runtime/modelRegistry';
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
} from './webPipeline';
import { createWebPipelineRecord } from '../domain/pipelineRecord';
import { installTrustedTypesPolicy } from './trustedTypes';

installTrustedTypesPolicy();
configureOnnxWorkerBootstrap({
  scriptUrl: onnxWorkerScriptUrl,
});
const platform = createOffscreenPlatform();
const translationTransport = createDirectTextTranslationTransport();
const modelSourceReady = createInstalledModelAssetSource().then(({ source }) => {
  configureModelAssetSource(source);
});
let fontReady: Promise<void> | null = null;

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

attachWorkerTranslatorHost<
  WebPipelineInput,
  PipelineConfig,
  PipelineProgress,
  WebPipelineResult
>({
  endpoint: globalThis as unknown as WorkerHostEndpoint,
  async execute({ input, config }, { signal, reportProgress }) {
    await modelSourceReady;
    await ensureFonts();
    if (signal.aborted) throw signal.reason;

    const file = await createNormalizedWorkingFile(input.file, input.workingCopy);
    if (signal.aborted) throw signal.reason;

    let artifacts: PipelineArtifacts | null = null;
    try {
      artifacts = await runPipeline(file, config, reportProgress, {
        signal,
        platform,
        translationTransport,
      });
      const finalizeStartedAt = performance.now();
      const image = await canvasToPngBlob(artifacts.resultCanvas);
      const debug = config.typesetDebug && artifacts.debugOriginalCanvas
        ? await canvasToPngBlob(artifacts.debugOriginalCanvas)
        : undefined;
      artifacts.stageTimings.push({
        stage: 'finalize',
        label: '生成结果图片',
        durationMs: performance.now() - finalizeStartedAt,
      });
      return {
        image,
        debug,
        summary: summarizePipelineArtifacts(artifacts),
        record: createWebPipelineRecord(artifacts),
      };
    } finally {
      if (artifacts) disposePipelineArtifacts(artifacts);
    }
  },
  serializeError(error) {
    const serialized = serializePipelineError(
      error,
      isAbortError(error) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED',
    );
    if (error instanceof PipelineStageError) {
      disposePipelineArtifacts(error.artifacts);
    }
    return serialized;
  },
});
