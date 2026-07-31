import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../src/runtime/platform';
import type { PipelineConfig, PipelineProgress, TextRegion } from '../../src/types';
import type {
  ImagePipelineRuntimeCapabilities,
  ProviderExecutionModel,
  ProviderExecutionPolicy,
  ProviderExecutionReport,
  ProviderRuntime,
} from '@shinobu/image-pipeline';
import {
  createPipelineRecord,
  hasTranslatableText,
  PRODUCTION_PROVIDER_EXECUTION_POLICY,
} from '@shinobu/image-pipeline';
import {
  type ProviderSessionResolver,
} from '../../src/runtime/providerExecution';

const pipelineMocks = vi.hoisted(() => ({
  fileToImage: vi.fn(),
  imageToCanvas: vi.fn(),
  detectTextRegionsWithMask: vi.fn(),
  runOcr: vi.fn(),
  runTranslate: vi.fn(),
  runInpaint: vi.fn(),
  drawTypeset: vi.fn(),
  drawRegions: vi.fn(),
  mergeTextLines: vi.fn(),
  refineTextMask: vi.fn(),
  sortRegionsForRender: vi.fn(),
  detectBubbles: vi.fn(),
  matchRegionsToBubbles: vi.fn(),
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
  requiredProviders: ['wasm'],
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
const failedDetectorProviderReport: ProviderExecutionReport = {
  ...detectorProviderReport,
  requiredProviders: ['wasm', 'cpu'],
  attempts: [
    {
      attempt: 1,
      provider: 'wasm',
      outcome: 'failed',
      reason: 'execution-failed',
    },
  ],
  finalProvider: undefined,
  satisfied: false,
};
const bubbleProviderReport: ProviderExecutionReport = {
  ...detectorProviderReport,
  model: 'bubble',
  stage: 'bubble',
};
const ocrProviderReport: ProviderExecutionReport = {
  ...detectorProviderReport,
  model: 'paddleocr_v6_medium_rec',
  stage: 'ocr',
};
const inpaintProviderReport: ProviderExecutionReport = {
  ...detectorProviderReport,
  model: 'inpaint',
  stage: 'inpaint',
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
const testRuntimeCapabilities: ImagePipelineRuntimeCapabilities = {
  providerExecution: {
    policy: PRODUCTION_PROVIDER_EXECUTION_POLICY,
    modelSession: {
      loadModel: async () => ({ runtime: ['wasm'] }),
      loadSession: async (model, provider) => ({
        sessionId: `${model}:${provider}`,
        provider,
        inputNames: ['images'],
        outputNames: ['output'],
      }),
    },
  },
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
  vi.resetAllMocks();
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
    providerReports: [ocrProviderReport],
  });
  pipelineMocks.runTranslate.mockResolvedValue({
    regions: [translatedRegion],
    translationDebug: { llmFallbackUsed: false },
  });
  pipelineMocks.runInpaint.mockResolvedValue({
    canvas: cleanedCanvas,
    actualProvider: 'wasm',
    providerReports: [inpaintProviderReport],
  });
  pipelineMocks.drawTypeset.mockResolvedValue({
    canvas: typesetCanvas,
    debugLog: null,
  });
  pipelineMocks.drawRegions.mockReturnValue(visualizedCanvas);
  pipelineMocks.mergeTextLines.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.refineTextMask.mockReturnValue({ refinedMaskCanvas });
  pipelineMocks.sortRegionsForRender.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.detectBubbles.mockResolvedValue({
    bubbles: [],
    actualProvider: 'wasm',
    providerReports: [bubbleProviderReport],
  });
  pipelineMocks.matchRegionsToBubbles.mockReturnValue({
    unmatchedCount: 0,
    unmatchedRegionIds: [],
  });
  pipelineMocks.browserPlatform.createCanvas.mockImplementation(createCanvas);
  pipelineMocks.browserPlatform.waitForFonts.mockResolvedValue(undefined);
});

describe('runPipeline', () => {
  it('fails closed before loading the image when provider model/session capability is missing', async () => {
    await expect(runPipeline(
      createFile(),
      baseConfig,
      () => {},
      { runtimeCapabilities: {} },
    )).rejects.toThrow('Provider execution capability is required');

    expect(pipelineMocks.fileToImage).not.toHaveBeenCalled();
  });

  it('preserves the full translate-stage order and returns typeset output', async () => {
    const progress: PipelineProgress[] = [];

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      { runtimeCapabilities: testRuntimeCapabilities },
    );

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
    expect(artifacts.providerReports).toEqual([
      detectorProviderReport,
      bubbleProviderReport,
      ocrProviderReport,
      inpaintProviderReport,
    ]);
    expect(pipelineMocks.detectBubbles).toHaveBeenCalledOnce();
    expect(pipelineMocks.runOcr).toHaveBeenCalledOnce();
    expect(pipelineMocks.runTranslate).toHaveBeenCalledOnce();
    expect(pipelineMocks.drawTypeset).toHaveBeenCalledOnce();
  });

  it('completes with input-equivalent empty artifacts before downstream model sessions', async () => {
    const progress: PipelineProgress[] = [];
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.empty-detection-wasm-only',
        version: 1,
      },
      rules: [
        { model: 'detector', stage: 'detect', providers: ['wasm'] },
        { model: 'bubble', stage: 'bubble', providers: ['wasm'] },
        {
          model: 'paddleocr_v6_medium_rec',
          stage: 'ocr',
          providers: ['wasm'],
        },
      ],
    };
    const loadSession = vi.fn(async (
      model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => ({
      sessionId: `${model}:${provider}`,
      provider,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
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
        regions: [],
        rawMaskCanvas: detectionMaskCanvas,
        engine: 'onnx' as const,
        actualProvider: execution.value,
        providerReports: [execution.report],
      };
    });
    pipelineMocks.detectBubbles.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const execution = await resolver.execute({
        model: 'bubble',
        stage: 'bubble',
        run: async (session) => session.provider,
      });
      return {
        bubbles: [],
        actualProvider: execution.value,
        providerReports: [execution.report],
      };
    });
    pipelineMocks.runOcr.mockImplementationOnce(async () => {
      throw new Error('OCR must not run after an empty successful detection');
    });

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      {
        runtimeCapabilities: {
          providerExecution: {
            policy,
            modelSession: {
              loadModel: vi.fn(),
              loadSession,
            },
          },
        },
      },
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'done',
    ]);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
      'detect',
    ]);
    expect(artifacts.detectedRegions).toEqual([]);
    expect(artifacts.stageRegions).toEqual({
      detected: [],
      ocr: [],
      merged: [],
      ordered: [],
    });
    expect(artifacts.cleanedCanvas).toBe(originalCanvas);
    expect(artifacts.resultCanvas).toBe(originalCanvas);
    expect(artifacts.segmentationCanvas).toBe(detectionMaskCanvas);
    expect(artifacts.providerReports).toHaveLength(1);
    expect(artifacts.providerReports[0]).toMatchObject({
      model: 'detector',
      stage: 'detect',
      finalProvider: 'wasm',
      satisfied: true,
    });
    expect(artifacts.runtimeStages).toEqual([
      expect.objectContaining({
        model: 'detector',
        enabled: true,
        engine: 'onnx',
        provider: 'wasm',
      }),
    ]);
    expect(loadSession.mock.calls).toEqual([
      ['detector', 'wasm'],
    ]);
    expect(pipelineMocks.detectBubbles).not.toHaveBeenCalled();
    expect(pipelineMocks.runOcr).not.toHaveBeenCalled();
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.refineTextMask).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();

    const record = createPipelineRecord({
      image: {
        width: artifacts.original.naturalWidth,
        height: artifacts.original.naturalHeight,
      },
      ocr: artifacts.stageRegions.ocr,
      ordered: artifacts.stageRegions.ordered,
    }, { strategy: 'source-native' });
    expect(hasTranslatableText({
      ordered: artifacts.stageRegions.ordered,
    })).toBe(false);
    expect(record.ocr).toEqual([]);
    expect(record.translations).toEqual([]);
  });

  it('preloads the detector through the injected runtime capability policy', async () => {
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
    const loadModel = vi.fn(async () => ({
      runtime: ['webgpu', 'webnn', 'wasm'] as const,
    }));
    const loadSession = vi.fn(async (
      _model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => ({
      sessionId: `detector:${provider}`,
      provider,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
    pipelineMocks.detectTextRegionsWithMask.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      expect(loadSession.mock.calls).toEqual([
        ['detector', 'wasm'],
      ]);
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
          providerExecution: {
            policy,
            modelSession: {
              loadModel,
              loadSession,
            },
          },
        },
      },
    );

    expect(loadModel).not.toHaveBeenCalled();
    expect(loadSession.mock.calls).toEqual([
      ['detector', 'wasm'],
    ]);
    expect(artifacts.providerReports[0]).toMatchObject({
      contract: policy.contract,
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('uses the injected resolver for every reached model stage', async () => {
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.all-stages-wasm',
        version: 2,
      },
      rules: [
        { model: 'detector', stage: 'detect', providers: ['wasm'] },
        { model: 'bubble', stage: 'bubble', providers: ['wasm'] },
        {
          model: 'paddleocr_v6_medium_rec',
          stage: 'ocr',
          providers: ['wasm'],
        },
        { model: 'inpaint', stage: 'inpaint', providers: ['wasm'] },
      ],
    };
    const loadSession = vi.fn(async (
      model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => ({
      sessionId: `${model}:${provider}`,
      provider,
      inputNames: ['images', 'mask'],
      outputNames: ['output'],
    }));
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
    pipelineMocks.detectBubbles.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const execution = await resolver.execute({
        model: 'bubble',
        stage: 'bubble',
        run: async (session) => session.provider,
      });
      return {
        bubbles: [],
        actualProvider: execution.value,
        providerReports: [execution.report],
      };
    });
    pipelineMocks.runOcr.mockImplementationOnce(async (
      _image: PipelineImage,
      _regions: TextRegion[],
      _providerName: string,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const execution = await resolver.execute({
        model: 'paddleocr_v6_medium_rec',
        stage: 'ocr',
        run: async (session) => session.provider,
      });
      return {
        regions: [ocrRegion],
        debug: null,
        actualProvider: execution.value,
        providerReports: [execution.report],
      };
    });
    pipelineMocks.runInpaint.mockImplementationOnce(async (
      _original: PipelineCanvas,
      _mask: PipelineCanvas,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const execution = await resolver.execute({
        model: 'inpaint',
        stage: 'inpaint',
        run: async (session) => session.provider,
      });
      return {
        canvas: cleanedCanvas,
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
          providerExecution: {
            policy,
            modelSession: {
              loadModel: vi.fn(),
              loadSession,
            },
          },
        },
      },
    );

    expect(artifacts.providerReports.map((report) => ({
      model: report.model,
      stage: report.stage,
      contract: report.contract,
      finalProvider: report.finalProvider,
      satisfied: report.satisfied,
    }))).toEqual([
      {
        model: 'detector',
        stage: 'detect',
        contract: policy.contract,
        finalProvider: 'wasm',
        satisfied: true,
      },
      {
        model: 'bubble',
        stage: 'bubble',
        contract: policy.contract,
        finalProvider: 'wasm',
        satisfied: true,
      },
      {
        model: 'paddleocr_v6_medium_rec',
        stage: 'ocr',
        contract: policy.contract,
        finalProvider: 'wasm',
        satisfied: true,
      },
      {
        model: 'inpaint',
        stage: 'inpaint',
        contract: policy.contract,
        finalProvider: 'wasm',
        satisfied: true,
      },
    ]);
  });

  it('does not attempt later providers when the bubble stage fails', async () => {
    const loadSession = vi.fn(async (
      model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => ({
      sessionId: `${model}:${provider}`,
      provider,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
    pipelineMocks.detectBubbles.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      const error = await resolver.execute({
        model: 'bubble',
        stage: 'bubble',
        run: async () => {
          throw new Error('GPU context lost');
        },
      }).then(() => null, (caught: unknown) => caught);
      throw Object.assign(new Error('bubble provider failed'), {
        providerReports: [
          (error as { report: ProviderExecutionReport }).report,
        ],
      });
    });

    const error = await runPipeline(
      createFile(),
      baseConfig,
      () => {},
      {
        runtimeCapabilities: {
          providerExecution: {
            policy: {
              schemaVersion: 1,
              contract: {
                id: 'test.stop-after-bubble',
                version: 1,
              },
              rules: [
                { model: 'detector', stage: 'detect', providers: ['wasm'] },
                { model: 'bubble', stage: 'bubble', providers: ['wasm'] },
                {
                  model: 'paddleocr_v6_medium_rec',
                  stage: 'ocr',
                  providers: ['wasm'],
                },
                { model: 'inpaint', stage: 'inpaint', providers: ['wasm'] },
              ],
            },
            modelSession: {
              loadModel: vi.fn(),
              loadSession,
            },
          },
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PipelineStageError);
    expect((error as PipelineStageError).artifacts.providerReports.map(
      (report) => report.model,
    )).toEqual(['detector', 'bubble']);
    expect(pipelineMocks.runOcr).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
  });

  it('skips translation and typesetting in erase mode', async () => {
    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, processMode: 'erase' },
      () => {},
      { runtimeCapabilities: testRuntimeCapabilities },
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
      { runtimeCapabilities: testRuntimeCapabilities },
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

  it('stops after order without reaching inpaint and preserves independent stage snapshots', async () => {
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
      providerReports: [ocrProviderReport],
    });
    pipelineMocks.mergeTextLines.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].sourceText = 'merged';
      return regions;
    });
    pipelineMocks.detectBubbles.mockResolvedValueOnce({
      bubbles: [{}],
      actualProvider: 'wasm',
      providerReports: [bubbleProviderReport],
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
    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, processMode: 'original' },
      (item) => progress.push(item),
      {
        stopAfter: 'order',
        runtimeCapabilities: testRuntimeCapabilities,
      },
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

  it('preserves structured detector provider failures and redacted diagnostics', async () => {
    const loadSession = vi.fn(async (
      model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => ({
      sessionId: `${model}:${provider}`,
      provider,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
    pipelineMocks.detectTextRegionsWithMask.mockImplementationOnce(async (
      _image: PipelineImage,
      _platform: PlatformProvider,
      resolver: ProviderSessionResolver,
    ) => {
      await resolver.execute({
        model: 'detector',
        stage: 'detect',
        run: async () => {
          throw new Error('raw GPU device detail');
        },
      });
      throw new Error('unreachable');
    });

    const error = await runPipeline(
      createFile(),
      baseConfig,
      () => {},
      {
        runtimeCapabilities: {
          providerExecution: {
            policy: PRODUCTION_PROVIDER_EXECUTION_POLICY,
            modelSession: {
              loadModel: async () => ({
                runtime: ['wasm', 'cpu'],
              }),
              loadSession,
            },
          },
        },
      },
    ).catch(
      (caught: unknown) => caught,
    );

    expect(loadSession.mock.calls).toEqual([['detector', 'wasm']]);
    expect(error).toBeInstanceOf(PipelineStageError);
    const stageError = error as PipelineStageError;
    expect(stageError).toMatchObject({
      name: 'PipelineStageError',
      code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
      stage: 'detect',
      stageLabel: '文本检测',
      failure: {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
        diagnostics: {
          contract: failedDetectorProviderReport.contract,
          model: 'detector',
          report: failedDetectorProviderReport,
        },
      },
    });
    expect(stageError.failure.diagnostics).not.toHaveProperty('message');
    expect(stageError.artifacts).toMatchObject({
      original: image,
      detectedRegions: [],
      detectionCanvas: originalCanvas,
      cleanedCanvas: originalCanvas,
      resultCanvas: originalCanvas,
      providerReports: [failedDetectorProviderReport],
    });
    expect(stageError.artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
    ]);
    expect(pipelineMocks.detectBubbles).not.toHaveBeenCalled();
    expect(pipelineMocks.runOcr).not.toHaveBeenCalled();
  });
});
