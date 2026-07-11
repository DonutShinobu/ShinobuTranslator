import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../src/runtime/platform';
import type { PipelineConfig, PipelineProgress, TextRegion } from '../../src/types';

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
    expect(pipelineMocks.runTranslate).toHaveBeenCalledOnce();
    expect(pipelineMocks.drawTypeset).toHaveBeenCalledOnce();
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

  it('attaches completed intermediate artifacts to stage errors', async () => {
    pipelineMocks.detectTextRegionsWithMask.mockRejectedValueOnce(new Error('detector unavailable'));

    const error = await runPipeline(createFile(), baseConfig, () => {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PipelineStageError);
    const stageError = error as PipelineStageError;
    expect(stageError).toMatchObject({
      name: 'PipelineStageError',
      stage: '文本检测',
      message: '文本检测失败: detector unavailable',
    });
    expect(stageError.artifacts).toMatchObject({
      original: image,
      detectedRegions: [],
      detectionCanvas: originalCanvas,
      cleanedCanvas: originalCanvas,
      resultCanvas: originalCanvas,
    });
    expect(stageError.artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
    ]);
  });
});
