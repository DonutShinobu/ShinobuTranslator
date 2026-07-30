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
import {
  createProductionProviderSessionResolver,
} from '../runtime/productionProviderExecution';
import {
  resolveBenchmarkProviderExecutionCapability,
  type BenchmarkProviderExecutionInput,
} from './providerExecution';

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
  bake: (dataUrl, options) => shinobuBake(
    dataUrl,
    browserPlatform,
    createProductionProviderSessionResolver(),
    options,
  ),
  render: (dataUrl) => shinobuRender(
    dataUrl,
    browserPlatform,
    createProductionProviderSessionResolver(),
  ),
  renderDebug: (dataUrl) => shinobuRenderDebug(
    dataUrl,
    browserPlatform,
    createProductionProviderSessionResolver(),
  ),
  renderFixtureDebug: (dataUrl, regions) => (
    shinobuRenderFixtureDebug(
      dataUrl,
      regions,
      browserPlatform,
      createProductionProviderSessionResolver(),
    )
  ),
  runPipeline: async (file, config, onProgress, options) => {
    const { runPipeline } = await import('../pipeline/orchestrator');
    const providerExecution = resolveBenchmarkProviderExecutionCapability(
      options?.runtimeCapabilities?.providerExecution as
        BenchmarkProviderExecutionInput | undefined,
    );
    return runPipeline(file, config, onProgress, {
      ...options,
      runtimeCapabilities: {
        ...options?.runtimeCapabilities,
        providerExecution,
      },
    });
  },
  recognizeOcrRegions: async (image, regions, providerName = 'paddleocr_v6_medium') => {
    await import('../pipeline/ocr');
    const { getOcrProvider } = await import('../pipeline/ocr/provider');
    const provider = getOcrProvider(providerName);
    if (!provider) {
      throw new Error(`OCR 引擎未注册: ${providerName}`);
    }
    const execution = await createProductionProviderSessionResolver().execute({
      model: 'paddleocr_v6_medium_rec',
      stage: 'ocr',
      run: (session) =>
        provider.recognize(image, regions, session, browserPlatform),
    });
    return execution.value;
  },
};

(window as ShinobuBenchmarkWindow).__shinobuBenchmark__ = benchmarkApi;
