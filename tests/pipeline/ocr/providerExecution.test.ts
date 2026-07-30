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

function successfulOcrOutput() {
  return {
    outputs: {
      output: {
        data: new Float32Array([0, 10, 0]),
        dims: [1, 1, 3],
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
});
