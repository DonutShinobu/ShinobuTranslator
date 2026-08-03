import { describe, expect, it, vi } from 'vitest';
import type { ModelName, ModelRuntime } from '@shinobu/model-runtime';
import {
  probeInstalledProductionModels,
  representativeFeeds,
} from '../../apps/web/src/runtime/modelCapability';

function assetId(name: ModelName): string {
  return name === 'paddleocr_v6_medium_rec' ? 'paddleocr-v6-medium' : name;
}

function installedSource(dispose = vi.fn()) {
  return {
    source: {
      manifestUrl: () => 'https://app.example/models/models.json',
      resolveAsset: (asset: string) => `blob:${asset}`,
    },
    dispose,
  };
}

function runtime(overrides: Partial<ModelRuntime>): ModelRuntime {
  return {
    readModel: vi.fn(),
    getSession: vi.fn(),
    run: vi.fn(),
    runImage: vi.fn(),
    readTextResource: vi.fn(),
    releaseSession: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('production model capability probe', () => {
  it('builds separate image and mask representative inputs', () => {
    const feeds = representativeFeeds(
      { inputNames: ['image', 'mask'] },
      {
        assetId: 'inpaint',
        modelName: 'inpaint',
        imageDims: [1, 3, 8, 8],
        maskDims: [1, 1, 8, 8],
      },
    );

    expect(feeds.image.dims).toEqual([1, 3, 8, 8]);
    expect(feeds.image.data).toHaveLength(192);
    expect(feeds.mask.dims).toEqual([1, 1, 8, 8]);
    expect(feeds.mask.data).toHaveLength(64);
  });

  it('runs all four models sequentially and releases every resource', async () => {
    const created: string[] = [];
    const released: string[] = [];
    const sourceDispose = vi.fn();
    const dispose = vi.fn(async () => undefined);
    const runCanary = vi.fn(async () => {
      throw new Error('full pipeline canary is intentionally slower than the startup gate');
    });
    const modelRuntime = runtime({
      getSession: vi.fn(async (name: ModelName) => {
        const id = assetId(name);
        created.push(id);
        return {
          sessionId: `${id}-session`,
          provider: 'wasm' as const,
          inputNames: name === 'inpaint' ? ['image', 'mask'] : ['input'],
          outputNames: ['output'],
        };
      }),
      run: vi.fn(async () => ({
        outputs: {
          output: {
            data: new Float32Array([1]),
            dims: [1],
            type: 'float32' as const,
          },
        },
      })),
      releaseSession: vi.fn(async (name: ModelName) => {
        released.push(`${assetId(name)}-session`);
      }),
      dispose,
    });
    const result = await probeInstalledProductionModels({
      backend: 'wasm',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => installedSource(sourceDispose)),
        createRuntime: () => modelRuntime,
        runCanary,
      },
    });

    expect(result).toEqual({ ok: true, provider: 'wasm' });
    expect(created).toEqual([
      'detector',
      'bubble',
      'paddleocr-v6-medium',
      'inpaint',
    ]);
    expect(released).toEqual(created.map((modelId) => `${modelId}-session`));
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(runCanary).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid inference output and still releases the session', async () => {
    const releaseSession = vi.fn(async () => undefined);
    const result = await probeInstalledProductionModels({
      backend: 'wasm',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => installedSource()),
        createRuntime: () => runtime({
          getSession: vi.fn(async () => ({
            sessionId: 'broken-session',
            provider: 'wasm' as const,
            inputNames: ['input'],
            outputNames: ['output'],
          })),
          run: vi.fn(async () => ({ outputs: {} })),
          releaseSession,
        }),
        runCanary: vi.fn(async () => undefined),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未返回有效输出/u);
    expect(releaseSession).toHaveBeenCalledWith('detector');
  });

  it('reports WASM when any production model falls back from WebGPU', async () => {
    let sessionIndex = 0;
    const result = await probeInstalledProductionModels({
      backend: 'webgpu',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => installedSource()),
        createRuntime: () => runtime({
          getSession: vi.fn(async () => {
            sessionIndex += 1;
            return {
              sessionId: `session-${sessionIndex}`,
              provider: sessionIndex === 2 ? 'wasm' as const : 'webgpu' as const,
              inputNames: ['input'],
              outputNames: ['output'],
            };
          }),
          run: vi.fn(async () => ({
            outputs: {
              output: {
                data: new Float32Array([1]),
                dims: [1],
                type: 'float32' as const,
              },
            },
          })),
        }),
        runCanary: vi.fn(async () => undefined),
      },
    });

    expect(result).toEqual({ ok: true, provider: 'wasm' });
  });
});
