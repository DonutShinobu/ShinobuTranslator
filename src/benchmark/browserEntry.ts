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
  runPipeline: async (file, config, onProgress) => {
    const { runPipeline } = await import('../pipeline/orchestrator');
    return runPipeline(file, config, onProgress);
  },
};

(window as ShinobuBenchmarkWindow).__shinobuBenchmark__ = benchmarkApi;
