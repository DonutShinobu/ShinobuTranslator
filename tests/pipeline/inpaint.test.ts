import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PlatformProvider,
} from '../../src/runtime/platform';
import { runInpaint } from '../../src/pipeline/inpaint';
import { createProviderSessionResolver } from '../../src/runtime/providerExecution';
import { getModel } from '../../src/runtime/modelRegistry';
import { runInference } from '../../src/runtime/onnxBridge';

vi.mock('../../src/runtime/modelRegistry', () => ({
  getModel: vi.fn(),
}));
vi.mock('../../src/runtime/onnxBridge', () => ({
  runInference: vi.fn(),
}));

type TestCanvas = PipelineCanvas & {
  pixels: Uint8ClampedArray;
};

function createCanvas(
  width: number,
  height: number,
  initial?: Uint8ClampedArray,
): TestCanvas {
  const canvas = {
    width,
    height,
    pixels: initial
      ? new Uint8ClampedArray(initial)
      : new Uint8ClampedArray(width * height * 4),
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,test',
  } as unknown as TestCanvas;
  const context = {
    drawImage(source: TestCanvas) {
      canvas.pixels = new Uint8ClampedArray(source.pixels);
    },
    getImageData() {
      return { data: new Uint8ClampedArray(canvas.pixels) };
    },
    createImageData(imageWidth: number, imageHeight: number) {
      return { data: new Uint8ClampedArray(imageWidth * imageHeight * 4) };
    },
    putImageData(image: { data: Uint8ClampedArray }) {
      canvas.pixels = new Uint8ClampedArray(image.data);
    },
  };
  return canvas;
}

function solidRgba(
  width: number,
  height: number,
  value: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return data;
}

function createPlatform(): PlatformProvider {
  return {
    createCanvas: (width: number, height: number) =>
      createCanvas(width, height),
  } as unknown as PlatformProvider;
}

function inpaintOutput(value: number) {
  return {
    outputs: {
      output: {
        data: new Float32Array(3 * 8 * 8).fill(value),
        dims: [1, 3, 8, 8],
        type: 'float32' as const,
      },
    },
  };
}

describe('inpaint provider execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getModel).mockResolvedValue({
      name: 'inpaint',
      task: 'inpaint',
      url: '/inpaint.onnx',
      input: [8],
      runtime: ['webgpu', 'webnn', 'wasm'],
      normalize: 'zero_to_one',
      outputNormalize: 'zero_to_one',
      maskFill: 'zero_before_normalize',
      maskInputName: 'mask',
    });
  });

  it('uses resolver attempts for device loss and invalid WebNN output before falling back to Wasm', async () => {
    vi.mocked(runInference).mockImplementation(async (sessionId) => {
      if (sessionId === 'inpaint:webgpu') {
        throw new Error('GPU device lost');
      }
      if (sessionId === 'inpaint:webnn') {
        return inpaintOutput(0);
      }
      return inpaintOutput(0.5);
    });
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({
        runtime: ['webgpu', 'webnn', 'wasm'],
      }),
      loadSession: async (model, provider) => ({
        sessionId: `${model}:${provider}`,
        provider,
        inputNames: ['image', 'mask'],
        outputNames: ['output'],
      }),
    });
    const original = createCanvas(8, 8, solidRgba(8, 8, 100));
    const mask = createCanvas(8, 8, solidRgba(8, 8, 255));

    const result = await runInpaint(
      original,
      mask,
      createPlatform(),
      resolver,
    );

    expect(result.actualProvider).toBe('wasm');
    expect(result.providerReports).toEqual([
      expect.objectContaining({
        model: 'inpaint',
        stage: 'inpaint',
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
            provider: 'webnn',
            outcome: 'failed',
            reason: 'execution-failed',
          },
          {
            attempt: 3,
            provider: 'wasm',
            outcome: 'succeeded',
            reason: 'completed',
          },
        ],
      }),
    ]);
    expect((result.canvas as TestCanvas).pixels[0]).toBe(128);
  });

  it('reports session creation fallback through the same resolver', async () => {
    vi.mocked(runInference).mockResolvedValue(inpaintOutput(0.5));
    const loadSession = vi.fn(async (model, provider) => {
      if (provider === 'webgpu') {
        throw new Error('WebGPU unavailable');
      }
      return {
        sessionId: `${model}:${provider}`,
        provider,
        inputNames: ['image', 'mask'],
        outputNames: ['output'],
      };
    });
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({ runtime: ['webgpu', 'wasm'] }),
      loadSession,
    });

    const result = await runInpaint(
      createCanvas(8, 8, solidRgba(8, 8, 100)),
      createCanvas(8, 8, solidRgba(8, 8, 255)),
      createPlatform(),
      resolver,
    );

    expect(result.providerReports[0]).toMatchObject({
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'unavailable',
          reason: 'session-unavailable',
        },
        {
          attempt: 2,
          provider: 'wasm',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('reports preparation failures as part of the reached provider execution', async () => {
    vi.mocked(getModel).mockRejectedValue(new Error('inpaint metadata unavailable'));
    const resolver = createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.inpaint-preparation-failure',
          version: 1,
        },
        rules: [{
          model: 'inpaint',
          stage: 'inpaint',
          providers: ['wasm'],
        }],
      },
      loadModel: vi.fn(),
      loadSession: async () => ({
        sessionId: 'inpaint:wasm',
        provider: 'wasm',
        inputNames: ['image', 'mask'],
        outputNames: ['output'],
      }),
    });

    const error = await runInpaint(
      createCanvas(8, 8, solidRgba(8, 8, 100)),
      createCanvas(8, 8, solidRgba(8, 8, 255)),
      createPlatform(),
      resolver,
    ).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      report: {
        contract: {
          id: 'test.inpaint-preparation-failure',
          version: 1,
        },
        model: 'inpaint',
        stage: 'inpaint',
        attempts: [{
          attempt: 1,
          provider: 'wasm',
          outcome: 'failed',
          reason: 'execution-failed',
        }],
        satisfied: false,
      },
    });
  });
});
