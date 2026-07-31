import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../../src/runtime/platform';
import type { TextRegion } from '../../../src/types';
import { runOcr } from '../../../src/pipeline/ocr';
import { createProviderSessionResolver } from '../../../src/runtime/providerExecution';
import { getModel } from '../../../src/runtime/modelRegistry';
import { runInference } from '../../../src/runtime/onnxBridge';
import { loadCharset } from '../../../src/pipeline/ocr/ocrShared';

vi.mock('../../../src/runtime/modelRegistry', () => ({
  getModel: vi.fn(),
}));
vi.mock('../../../src/runtime/onnxBridge', () => ({
  runInference: vi.fn(),
}));
vi.mock('../../../src/pipeline/ocr/ocrShared', () => ({
  loadCharset: vi.fn(),
}));
vi.mock('../../../src/pipeline/ocr/paddleocrPreprocess', () => ({
  buildPaddleOcrInput: vi.fn(() => ({
    data: new Float32Array(3 * 48 * 8),
    dims: [1, 3, 48, 8],
    resizedWidth: 8,
  })),
}));

const image: PipelineImage = {
  src: 'fixture.png',
  naturalWidth: 20,
  naturalHeight: 10,
  onload: null,
  onerror: null,
};
const region: TextRegion = {
  id: 'region-1',
  box: { x: 1, y: 1, width: 8, height: 4 },
  direction: 'h',
  sourceText: '',
  translatedText: '',
};
const secondRegion: TextRegion = {
  ...region,
  id: 'region-2',
  box: { x: 10, y: 1, width: 8, height: 4 },
};

function createPlatform(): PlatformProvider {
  return {
    createCanvas(width: number, height: number): PipelineCanvas {
      const context = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        })),
      };
      return {
        width,
        height,
        getContext: () => context,
        toDataURL: () => 'data:image/png;base64,test',
      } as unknown as PipelineCanvas;
    },
  } as unknown as PlatformProvider;
}

function successfulOcrOutput(batchSize = 1) {
  return {
    outputs: {
      output: {
        data: new Float32Array(
          Array.from({ length: batchSize }, () => [0, 10, 0]).flat(),
        ),
        dims: [batchSize, 1, 3],
        type: 'float32' as const,
      },
    },
  };
}

describe('OCR provider execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getModel).mockResolvedValue({
      name: 'paddleocr_v6_medium_rec',
      task: 'ocr',
      url: '/ocr.onnx',
      input: [48, 320],
      runtime: ['webgpu', 'webnn', 'wasm'],
      dictUrl: '/ocr.txt',
      normalize: 'minus_one_to_one',
      channelOrder: 'rgb',
    });
    vi.mocked(loadCharset).mockResolvedValue(['あ']);
  });

  it('retries the whole OCR operation through the resolver after execution failure', async () => {
    vi.mocked(runInference).mockImplementation(async (sessionId) => {
      if (sessionId === 'paddleocr_v6_medium_rec:webgpu') {
        throw new Error('GPU context lost');
      }
      return successfulOcrOutput();
    });
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({
        runtime: ['webgpu', 'wasm'],
      }),
      loadSession: async (model, provider) => ({
        sessionId: `${model}:${provider}`,
        provider,
        inputNames: ['images'],
        outputNames: ['output'],
      }),
    });

    const result = await runOcr(
      image,
      [region],
      'paddleocr_v6_medium',
      createPlatform(),
      resolver,
    );

    expect(result.regions).toEqual([
      expect.objectContaining({
        id: 'region-1',
        sourceText: 'あ',
      }),
    ]);
    expect(result.actualProvider).toBe('wasm');
    expect(result.providerReports).toEqual([
      expect.objectContaining({
        model: 'paddleocr_v6_medium_rec',
        stage: 'ocr',
        finalProvider: 'wasm',
        satisfied: true,
        attempts: [
          {
            attempt: 1,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'execution-failed',
          },
          {
            attempt: 2,
            provider: 'wasm',
            outcome: 'succeeded',
            reason: 'completed',
          },
        ],
      }),
    ]);
  });

  it('uses the injected provider policy', async () => {
    vi.mocked(runInference).mockResolvedValue(successfulOcrOutput());
    const loadSession = vi.fn(async (model, provider) => ({
      sessionId: `${model}:${provider}`,
      provider,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
    const resolver = createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.ocr-wasm-only',
          version: 1,
        },
        rules: [{
          model: 'paddleocr_v6_medium_rec',
          stage: 'ocr',
          providers: ['wasm'],
        }],
      },
      loadModel: vi.fn(),
      loadSession,
    });

    const result = await runOcr(
      image,
      [region],
      'paddleocr_v6_medium',
      createPlatform(),
      resolver,
    );

    expect(result.actualProvider).toBe('wasm');
    expect(result.providerReports[0]).toMatchObject({
      contract: {
        id: 'test.ocr-wasm-only',
        version: 1,
      },
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('rebuilds a lost session before retrying an OCR batch', async () => {
    let sessionGeneration = 0;
    const resetRuntime = vi.fn(async () => undefined);
    vi.mocked(runInference)
      .mockResolvedValueOnce({
        outputs: {},
        failure: {
          code: 'session-lost',
          detail: 'private adapter detail',
        },
      })
      .mockImplementation(async () => successfulOcrOutput());
    const resolver = createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.ocr-webgpu-only',
          version: 1,
        },
        rules: [{
          model: 'paddleocr_v6_medium_rec',
          stage: 'ocr',
          providers: ['webgpu'],
        }],
      },
      loadModel: vi.fn(),
      loadSession: async (model, provider) => ({
        sessionId: `${model}:${provider}:${sessionGeneration += 1}`,
        provider,
        inputNames: ['images'],
        outputNames: ['output'],
      }),
      resetRuntime,
    });

    const result = await runOcr(
      image,
      [region, secondRegion],
      'paddleocr_v6_medium',
      createPlatform(),
      resolver,
    );

    expect(resetRuntime).toHaveBeenCalledOnce();
    const sessionIds = vi.mocked(runInference).mock.calls
      .map(([sessionId]) => sessionId);
    expect(sessionIds[0]).toBe('paddleocr_v6_medium_rec:webgpu:1');
    expect(sessionIds.slice(1)).not.toHaveLength(0);
    expect(sessionIds.slice(1).every((sessionId) =>
      sessionId === 'paddleocr_v6_medium_rec:webgpu:2')).toBe(true);
    expect(result.providerReports[0]).toMatchObject({
      requiredProviders: ['webgpu'],
      finalProvider: 'webgpu',
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'failed',
          reason: 'session-lost',
        },
        {
          attempt: 2,
          provider: 'webgpu',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
    });
  });
});
