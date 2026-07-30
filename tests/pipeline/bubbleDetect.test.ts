import { describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../src/runtime/platform';
import { detectBubbles } from '../../src/pipeline/bubbleDetect';
import { createProviderSessionResolver } from '../../src/runtime/providerExecution';
import { runInference } from '../../src/runtime/onnxBridge';

vi.mock('../../src/runtime/onnxBridge', () => ({
  runInference: vi.fn(),
}));

const image: PipelineImage = {
  src: 'fixture.png',
  naturalWidth: 20,
  naturalHeight: 10,
  onload: null,
  onerror: null,
};

function createPlatform(): PlatformProvider {
  return {
    createCanvas(width: number, height: number): PipelineCanvas {
      const context = {
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(width * height * 4),
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

function successfulOutputs() {
  return {
    outputs: {
      output0: {
        data: new Float32Array(37),
        dims: [1, 37, 1],
        type: 'float32' as const,
      },
      output1: {
        data: new Float32Array(32),
        dims: [1, 32, 1, 1],
        type: 'float32' as const,
      },
    },
  };
}

describe('bubble provider execution', () => {
  it('falls back through the shared resolver after a context-loss execution failure', async () => {
    vi.mocked(runInference).mockImplementation(async (sessionId) => {
      if (sessionId === 'bubble:webgpu') {
        throw new Error('GPU context lost');
      }
      return successfulOutputs();
    });
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({ runtime: ['webgpu', 'wasm'] }),
      loadSession: async (model, providers) => ({
        sessionId: `${model}:${providers[0]}`,
        provider: providers[0],
        inputNames: ['images'],
        outputNames: ['output0', 'output1'],
      }),
    });

    const result = await detectBubbles(image, createPlatform(), resolver);

    expect(result.bubbles).toEqual([]);
    expect(result.actualProvider).toBe('wasm');
    expect(result.providerReports).toEqual([
      expect.objectContaining({
        model: 'bubble',
        stage: 'bubble',
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

  it('retains the successful provider report when bubble output decoding fails', async () => {
    vi.mocked(runInference).mockResolvedValue({
      outputs: {
        output0: {
          data: new Float32Array(36),
          dims: [1, 36, 1],
          type: 'float32',
        },
        output1: {
          data: new Float32Array(32),
          dims: [1, 32, 1, 1],
          type: 'float32',
        },
      },
    });
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({ runtime: ['wasm'] }),
      loadSession: async () => ({
        sessionId: 'bubble:wasm',
        provider: 'wasm',
        inputNames: ['images'],
        outputNames: ['output0', 'output1'],
      }),
    });

    const error = await detectBubbles(
      image,
      createPlatform(),
      resolver,
    ).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      providerReports: [
        {
          model: 'bubble',
          stage: 'bubble',
          finalProvider: 'wasm',
          satisfied: true,
        },
      ],
    });
  });
});
