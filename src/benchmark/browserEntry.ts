import {
  shinobuBake,
  shinobuRender,
  shinobuRenderDebug,
  shinobuRenderFixtureDebug,
} from '../pipeline/bake';
import type {
  BakeResult,
  ShinobuBakeOptions,
  RenderDebugResult,
  RenderFixtureRegion,
} from '../pipeline/bake';
import type { OcrRecognizeOutput } from '../pipeline/ocr/provider';
import type { PipelineImage } from '../runtime/platform';
import type { TextRegion } from '../types';
import { browserPlatform } from '../runtime/browserPlatform';

export type ShinobuBenchmarkApi = {
  bake(dataUrl: string, options?: ShinobuBakeOptions): Promise<BakeResult>;
  render(dataUrl: string): Promise<string>;
  renderDebug(dataUrl: string): Promise<RenderDebugResult>;
  renderFixtureDebug(
    dataUrl: string,
    regions: RenderFixtureRegion[],
  ): Promise<RenderDebugResult>;
  runPipeline: typeof import('../pipeline/orchestrator')['runPipeline'];
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
  bake: (dataUrl, options) => shinobuBake(dataUrl, browserPlatform, options),
  render: (dataUrl) => shinobuRender(dataUrl, browserPlatform),
  renderDebug: (dataUrl) => shinobuRenderDebug(dataUrl, browserPlatform),
  renderFixtureDebug: (dataUrl, regions) => (
    shinobuRenderFixtureDebug(dataUrl, regions, browserPlatform)
  ),
  runPipeline: async (file, config, onProgress, options) => {
    const { runPipeline } = await import('../pipeline/orchestrator');
    return runPipeline(file, config, onProgress, options);
  },
  recognizeOcrRegions: async (image, regions, providerName = 'paddleocr_v6_medium') => {
    await import('../pipeline/ocr');
    const { getOcrProvider } = await import('../pipeline/ocr/provider');
    const provider = getOcrProvider(providerName);
    if (!provider) {
      throw new Error(`OCR 引擎未注册: ${providerName}`);
    }
    return provider.recognize(image, regions, browserPlatform);
  },
};

(window as ShinobuBenchmarkWindow).__shinobuBenchmark__ = benchmarkApi;
