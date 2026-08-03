import {
  shinobuBake,
  shinobuRender,
  shinobuRenderDebug,
  shinobuRenderFixtureDebug,
} from '@shinobu/image-pipeline/benchmark';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createExtensionModelRuntime } from '../shared/extensionModelRuntime';

const modelRuntime = createExtensionModelRuntime();
import type {
  BakeResult,
  ShinobuBakeOptions,
  RenderDebugResult,
  RenderFixtureRegion,
  OcrRecognizeOutput,
  PipelineImage,
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  TextRegion,
} from '@shinobu/image-pipeline/benchmark';

export type ShinobuBenchmarkApi = {
  bake(dataUrl: string, options?: ShinobuBakeOptions): Promise<BakeResult>;
  render(dataUrl: string): Promise<string>;
  renderDebug(dataUrl: string): Promise<RenderDebugResult>;
  renderFixtureDebug(
    dataUrl: string,
    regions: RenderFixtureRegion[],
  ): Promise<RenderDebugResult>;
  runPipeline(
    file: File,
    config: PipelineConfig,
    onProgress: (progress: PipelineProgress) => void,
    options?: { signal?: AbortSignal; stopAfter?: 'order' },
  ): Promise<PipelineArtifacts>;
  recognizeOcrRegions(
    image: PipelineImage,
    regions: TextRegion[],
    providerName?: string,
  ): Promise<OcrRecognizeOutput>;
};

export type ShinobuBenchmarkWindow = typeof window & {
  __shinobuBenchmark__?: ShinobuBenchmarkApi;
};

const benchmarkApi: ShinobuBenchmarkApi = {
  bake: (dataUrl, options) => shinobuBake(dataUrl, browserPipelinePlatform, modelRuntime, options),
  render: (dataUrl) => shinobuRender(dataUrl, browserPipelinePlatform, modelRuntime),
  renderDebug: (dataUrl) => shinobuRenderDebug(dataUrl, browserPipelinePlatform, modelRuntime),
  renderFixtureDebug: (dataUrl, regions) => (
    shinobuRenderFixtureDebug(dataUrl, regions, browserPipelinePlatform, modelRuntime)
  ),
  runPipeline: async (file, config, onProgress, options) => {
    const { runPipeline } = await import('@shinobu/image-pipeline/benchmark');
    return runPipeline(file, config, onProgress, {
      ...options,
      modelRuntime,
      detectionFallbackStrategy: { kind: 'heuristic-only' },
    });
  },
  recognizeOcrRegions: async (image, regions, providerName = 'paddleocr_v6_medium') => {
    const { getOcrProvider } = await import('@shinobu/image-pipeline/benchmark');
    const provider = getOcrProvider(providerName);
    if (!provider) {
      throw new Error(`OCR 引擎未注册: ${providerName}`);
    }
    return provider.recognize(image, regions, browserPipelinePlatform, modelRuntime);
  },
};

(window as ShinobuBenchmarkWindow).__shinobuBenchmark__ = benchmarkApi;
