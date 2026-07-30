import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../src/runtime/platform';
import type { PipelineConfig, PipelineProgress, TextRegion } from '../../src/types';
import type {
  ProviderExecutionPolicy,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import type { ProviderSessionResolver } from '../../src/runtime/providerExecution';

const pipelineMocks = vi.hoisted(() => ({
  fileToImage: vi.fn(),
  imageToCanvas: vi.fn(),
  detectTextRegionsWithMask: vi.fn(),
  runOcr: vi.fn(),
  preparePaddleOcrRuntime: vi.fn(),
  warmupPaddleOcrRuntime: vi.fn(),
  runTranslate: vi.fn(),
  runInpaint: vi.fn(),
  drawTypeset: vi.fn(),
  drawRegions: vi.fn(),
  mergeTextLines: vi.fn(),
  refineTextMask: vi.fn(),
  sortRegionsForRender: vi.fn(),
  detectBubbles: vi.fn(),
  matchRegionsToBubbles: vi.fn(),
  getModelSession: vi.fn(),
  browserPlatform: {
    createCanvas: vi.fn(),
    createImage: vi.fn(),
    loadImage: vi.fn(),
    createImageData: vi.fn(),
    registerFont: vi.fn(),
    waitForFonts: vi.fn(),
  },
}));

vi.mock('../../src/runtime/browserPlatform', () => ({
  browserPlatform: pipelineMocks.browserPlatform,
}));
vi.mock('../../src/pipeline/image', () => ({
  fileToImage: pipelineMocks.fileToImage,
  imageToCanvas: pipelineMocks.imageToCanvas,
}));
vi.mock('../../src/pipeline/detect', () => ({
  detectTextRegionsWithMask: pipelineMocks.detectTextRegionsWithMask,
}));
vi.mock('../../src/pipeline/ocr', () => ({
  runOcr: pipelineMocks.runOcr,
}));
vi.mock('../../src/pipeline/ocr/paddleocrProvider', () => ({
  preparePaddleOcrRuntime: pipelineMocks.preparePaddleOcrRuntime,
  warmupPaddleOcrRuntime: pipelineMocks.warmupPaddleOcrRuntime,
}));
vi.mock('../../src/pipeline/translate', () => ({
  runTranslate: pipelineMocks.runTranslate,
}));
vi.mock('../../src/pipeline/inpaint', () => ({
  runInpaint: pipelineMocks.runInpaint,
}));
vi.mock('../../src/pipeline/typeset', () => ({
  drawTypeset: pipelineMocks.drawTypeset,
}));
vi.mock('../../src/pipeline/visualize', () => ({
  drawRegions: pipelineMocks.drawRegions,
}));
vi.mock('../../src/pipeline/textlineMerge', () => ({
  mergeTextLines: pipelineMocks.mergeTextLines,
}));
vi.mock('../../src/pipeline/maskRefinement', () => ({
  refineTextMask: pipelineMocks.refineTextMask,
}));
vi.mock('../../src/pipeline/readingOrder', () => ({
  sortRegionsForRender: pipelineMocks.sortRegionsForRender,
}));
vi.mock('../../src/pipeline/bubbleDetect', () => ({
  detectBubbles: pipelineMocks.detectBubbles,
  matchRegionsToBubbles: pipelineMocks.matchRegionsToBubbles,
}));
vi.mock('../../src/runtime/modelRegistry', () => ({
  getModelSession: pipelineMocks.getModelSession,
}));

import { PipelineStageError, runPipeline } from '../../src/pipeline/orchestrator';

function createCanvas(width = 100, height = 200): PipelineCanvas {
  return {
    width,
    height,
    getContext: () => null,
    toDataURL: () => 'data:image/png;base64,test',
  };
}

const image: PipelineImage = {
  src: 'fixture.png',
  naturalWidth: 100,
  naturalHeight: 200,
  onload: null,
  onerror: null,
};
const originalCanvas = createCanvas();
const detectionMaskCanvas = createCanvas(25, 50);
const visualizedCanvas = createCanvas();
const refinedMaskCanvas = createCanvas();
const cleanedCanvas = createCanvas();
const typesetCanvas = createCanvas();

const detectedRegion: TextRegion = {
  id: 'region-1',
  box: { x: 10, y: 20, width: 30, height: 80 },
  direction: 'v',
  sourceText: '',
  translatedText: '',
};
const ocrRegion: TextRegion = {
  ...detectedRegion,
  sourceText: 'こんにちは',
};
const translatedRegion: TextRegion = {
  ...ocrRegion,
  translatedText: '你好',
};
const detectorProviderReport: ProviderExecutionReport = {
  schemaVersion: 1,
  contract: {
    id: 'shinobu.production-provider-policy',
    version: 1,
  },
  model: 'detector',
  stage: 'detect',
  attempts: [
    {
      attempt: 1,
      provider: 'wasm',
      outcome: 'succeeded',
      reason: 'completed',
    },
  ],
  finalProvider: 'wasm',
  fallbackTrace: [],
  satisfied: true,
};

const baseConfig: PipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'google_web',
  llmProvider: 'deepseek',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-v4-flash',
  typesetDebug: false,
  eraseDebug: false,
  collectDebugLog: false,
  ocrEngine: 'paddleocr_v6_medium',
  ocrPostFilter: 'off',
  processMode: 'translate',
};

function createFile(): File {
  return new File(['fixture'], 'fixture.png', { type: 'image/png' });
}

function uniqueConsecutiveStages(progress: PipelineProgress[]): string[] {
  return progress
    .map((item) => item.stage)
    .filter((stage, index, stages) => index === 0 || stage !== stages[index - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  const sessionHandle = { provider: 'wasm' as const };
  pipelineMocks.fileToImage.mockResolvedValue(image);
  pipelineMocks.imageToCanvas.mockReturnValue(originalCanvas);
  pipelineMocks.detectTextRegionsWithMask.mockResolvedValue({
    regions: [detectedRegion],
    rawMaskCanvas: detectionMaskCanvas,
    actualProvider: 'wasm',
    providerReports: [detectorProviderReport],
  });
  pipelineMocks.runOcr.mockResolvedValue({
    regions: [ocrRegion],
    debug: null,
    actualProvider: 'wasm',
  });
  pipelineMocks.preparePaddleOcrRuntime.mockResolvedValue({
    modelName: 'paddleocr_v6_medium_rec',
    sessionHandle,
  });
  pipelineMocks.warmupPaddleOcrRuntime.mockResolvedValue({
    modelName: 'paddleocr_v6_medium_rec',
    provider: 'wasm',
    inputDims: [1, 3, 48, 320],
    runMs: 1,
  });
  pipelineMocks.runTranslate.mockResolvedValue({
    regions: [translatedRegion],
    translationDebug: { llmFallbackUsed: false },
  });
  pipelineMocks.runInpaint.mockResolvedValue({
    canvas: cleanedCanvas,
    actualProvider: 'wasm',
  });
  pipelineMocks.drawTypeset.mockResolvedValue({
    canvas: typesetCanvas,
    debugLog: null,
  });
  pipelineMocks.drawRegions.mockReturnValue(visualizedCanvas);
  pipelineMocks.mergeTextLines.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.refineTextMask.mockReturnValue({ refinedMaskCanvas });
  pipelineMocks.sortRegionsForRender.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.detectBubbles.mockResolvedValue({ bubbles: [] });
  pipelineMocks.matchRegionsToBubbles.mockReturnValue({
    unmatchedCount: 0,
    unmatchedRegionIds: [],
  });
  pipelineMocks.getModelSession.mockResolvedValue(sessionHandle);
  pipelineMocks.browserPlatform.createCanvas.mockImplementation(createCanvas);
  pipelineMocks.browserPlatform.waitForFonts.mockResolvedValue(undefined);

  const runtimeFlags = globalThis as typeof globalThis & {
    __shinobuPaddleOcrRuntimeProbe?: unknown;
    __shinobuPaddleOcrRuntimeProbeSchedule?: unknown;
    __shinobuInpaintRuntimeProbeSchedule?: unknown;
    __shinobuBubbleRuntimeProbeSchedule?: unknown;
  };
  delete runtimeFlags.__shinobuPaddleOcrRuntimeProbe;
  delete runtimeFlags.__shinobuPaddleOcrRuntimeProbeSchedule;
  delete runtimeFlags.__shinobuInpaintRuntimeProbeSchedule;
  delete runtimeFlags.__shinobuBubbleRuntimeProbeSchedule;
});

describe('runPipeline', () => {
  it('preserves the full translate-stage order and returns typeset output', async () => {
    const progress: PipelineProgress[] = [];

    const artifacts = await runPipeline(createFile(), baseConfig, (item) => progress.push(item));

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
      'parallel',
      'typeset',
      'done',
    ]);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'preload_inpaint',
      'merge',
      'order',
      'translate',
      'mask_refine',
      'inpaint',
      'parallel',
      'typeset',
    ]);
    expect(artifacts.detectedRegions).toEqual([translatedRegion]);
    expect(artifacts.resultCanvas).toBe(typesetCanvas);
    expect(artifacts.providerReports).toEqual([detectorProviderReport]);
    expect(pipelineMocks.runTranslate).toHaveBeenCalledOnce();
    expect(pipelineMocks.drawTypeset).toHaveBeenCalledOnce();
  });

  it('injects the runtime capability policy into detector provider resolution', async () => {
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.detector-wasm-only',
        version: 4,
      },
      rules: [
        {
          model: 'detector',
          stage: 'detect',
          providers: ['wasm'],
        },
      ],
    };
    pipelineMocks.detectTextRegionsWithMask.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const execution = await resolver.execute({
        model: 'detector',
        stage: 'detect',
        run: async (session) => session.provider,
      });
      return {
        regions: [detectedRegion],
        rawMaskCanvas: detectionMaskCanvas,
        actualProvider: execution.value,
        providerReports: [execution.report],
      };
    });

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      () => {},
      {
        runtimeCapabilities: {
          providerExecution: { policy },
        },
      },
    );

    expect(pipelineMocks.getModelSession.mock.calls.filter(
      ([model]) => model === 'detector',
    )).toEqual([
      ['detector', ['wasm']],
    ]);
    expect(artifacts.providerReports[0]).toMatchObject({
      contract: policy.contract,
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('skips translation and typesetting in erase mode', async () => {
    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, processMode: 'erase' },
      () => {},
    );

    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();
    expect(artifacts.detectedRegions).toEqual([ocrRegion]);
    expect(artifacts.resultCanvas).toBe(cleanedCanvas);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).not.toContain('typeset');
  });

  it('skips translation but typesets source regions in original mode', async () => {
    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, processMode: 'original' },
      () => {},
    );

    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).toHaveBeenCalledWith(
      cleanedCanvas,
      [ocrRegion],
      'zh-CHS',
      expect.objectContaining({ renderText: true }),
      pipelineMocks.browserPlatform as PlatformProvider,
    );
    expect(artifacts.resultCanvas).toBe(typesetCanvas);
  });

  it('stops after order, skips inpaint preload, and preserves independent stage snapshots', async () => {
    const progress: PipelineProgress[] = [];
    const stageRegion: TextRegion = {
      ...ocrRegion,
      box: { ...ocrRegion.box },
    };
    const bubbleMask = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      data: new Uint8Array([1]),
    };
    pipelineMocks.runOcr.mockResolvedValueOnce({
      regions: [stageRegion],
      debug: null,
      actualProvider: 'wasm',
    });
    pipelineMocks.mergeTextLines.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].sourceText = 'merged';
      return regions;
    });
    pipelineMocks.detectBubbles.mockResolvedValueOnce({
      bubbles: [{}],
      actualProvider: 'wasm',
    });
    pipelineMocks.matchRegionsToBubbles.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].bubbleBox = { x: 1, y: 2, width: 3, height: 4 };
      regions[0].bubbleMask = bubbleMask;
      return { unmatchedCount: 0, unmatchedRegionIds: [] };
    });
    pipelineMocks.sortRegionsForRender.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].fontSize = 42;
      return regions;
    });
    (
      globalThis as typeof globalThis & {
        __shinobuInpaintRuntimeProbeSchedule?: 'detect-start';
      }
    ).__shinobuInpaintRuntimeProbeSchedule = 'detect-start';

    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, processMode: 'original' },
      (item) => progress.push(item),
      { stopAfter: 'order' },
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
      'done',
    ]);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
    ]);
    expect(artifacts.runtimeStages.map((stage) => stage.model)).not.toContain('inpaint');
    expect(pipelineMocks.getModelSession.mock.calls.some(([model]) => model === 'inpaint')).toBe(false);
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.refineTextMask).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();

    expect(artifacts.stageRegions.detected[0]).toEqual(detectedRegion);
    expect(artifacts.stageRegions.detected[0]).not.toBe(detectedRegion);
    expect(artifacts.stageRegions.ocr[0].sourceText).toBe('こんにちは');
    expect(artifacts.stageRegions.merged[0]).toMatchObject({
      sourceText: 'merged',
    });
    expect(artifacts.stageRegions.merged[0].bubbleBox).toBeUndefined();
    expect(artifacts.stageRegions.merged[0].fontSize).toBeUndefined();
    expect(artifacts.stageRegions.ordered[0].bubbleBox).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(artifacts.stageRegions.ordered[0].fontSize).toBe(42);
    expect(artifacts.stageRegions.merged[0]).not.toBe(artifacts.stageRegions.ordered[0]);
    expect(artifacts.stageRegions.ordered[0].bubbleMask).toBeUndefined();
    artifacts.stageRegions.merged[0].box.x = 999;
    expect(artifacts.stageRegions.ordered[0].box.x).not.toBe(999);
  });

  it('attaches completed intermediate artifacts to stage errors', async () => {
    pipelineMocks.detectTextRegionsWithMask.mockRejectedValueOnce(Object.assign(
      new Error('detector unavailable'),
      { providerReports: [detectorProviderReport] },
    ));

    const error = await runPipeline(createFile(), baseConfig, () => {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PipelineStageError);
    const stageError = error as PipelineStageError;
    expect(stageError).toMatchObject({
      name: 'PipelineStageError',
      code: 'PIPELINE_STAGE_FAILED',
      stage: 'detect',
      stageLabel: '文本检测',
      message: '文本检测失败: detector unavailable',
      failure: {
        code: 'PIPELINE_STAGE_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.stage',
        diagnostics: {
          name: 'PipelineStageError',
          providerReports: [detectorProviderReport],
        },
      },
    });
    expect(stageError.cause).toMatchObject({ message: 'detector unavailable' });
    expect(stageError.artifacts).toMatchObject({
      original: image,
      detectedRegions: [],
      detectionCanvas: originalCanvas,
      cleanedCanvas: originalCanvas,
      resultCanvas: originalCanvas,
      providerReports: [detectorProviderReport],
    });
    expect(stageError.artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
    ]);
  });
});
