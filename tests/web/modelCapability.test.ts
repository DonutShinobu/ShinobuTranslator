import { describe, expect, it, vi } from 'vitest';
import {
  probeInstalledProductionModels,
  representativeFeeds,
} from '../../apps/web/src/runtime/modelCapability';

describe('production model capability probe', () => {
  it('builds separate image and mask representative inputs', () => {
    const feeds = representativeFeeds(
      { inputNames: ['image', 'mask'] },
      {
        assetId: 'inpaint',
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
    const disposed: string[] = [];
    const sourceDispose = vi.fn();
    const disposeAll = vi.fn(async () => undefined);
    const runCanary = vi.fn(async () => {
      throw new Error('full pipeline canary is intentionally slower than the startup gate');
    });
    const result = await probeInstalledProductionModels({
      backend: 'wasm',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => ({
          source: {
            manifestUrl: () => 'https://app.example/models/models.json',
            resolveAsset: (asset: string) => `blob:${asset}`,
          },
          dispose: sourceDispose,
        })),
        createSession: vi.fn(async (modelKey: string) => {
          const modelId = modelKey.replace('web-capability-', '');
          created.push(modelId);
          return {
            sessionId: `${modelId}-session`,
            provider: 'wasm' as const,
            inputNames: modelId === 'inpaint' ? ['image', 'mask'] : ['input'],
            outputNames: ['output'],
          };
        }),
        runInference: vi.fn(async () => ({
          outputs: {
            output: {
              data: new Float32Array([1]),
              dims: [1],
              type: 'float32' as const,
            },
          },
        })),
        disposeSession: vi.fn(async (sessionId: string) => {
          disposed.push(sessionId);
        }),
        disposeAll,
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
    expect(disposed).toEqual(created.map((modelId) => `${modelId}-session`));
    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(disposeAll).toHaveBeenCalledOnce();
    expect(runCanary).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid inference output and still disposes the session', async () => {
    const disposeSession = vi.fn(async () => undefined);
    const result = await probeInstalledProductionModels({
      backend: 'wasm',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => ({
          source: {
            manifestUrl: () => 'https://app.example/models/models.json',
            resolveAsset: (asset: string) => `blob:${asset}`,
          },
          dispose: vi.fn(),
        })),
        createSession: vi.fn(async () => ({
          sessionId: 'broken-session',
          provider: 'wasm' as const,
          inputNames: ['input'],
          outputNames: ['output'],
        })),
        runInference: vi.fn(async () => ({ outputs: {} })),
        disposeSession,
        disposeAll: vi.fn(async () => undefined),
        runCanary: vi.fn(async () => undefined),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未返回有效输出/u);
    expect(disposeSession).toHaveBeenCalledWith('broken-session');
  });

  it('reports WASM when any production model falls back from WebGPU', async () => {
    let sessionIndex = 0;
    const result = await probeInstalledProductionModels({
      backend: 'webgpu',
      useCache: false,
      dependencies: {
        createSource: vi.fn(async () => ({
          source: {
            manifestUrl: () => 'https://app.example/models/models.json',
            resolveAsset: (asset: string) => `blob:${asset}`,
          },
          dispose: vi.fn(),
        })),
        createSession: vi.fn(async () => {
          sessionIndex += 1;
          return {
            sessionId: `session-${sessionIndex}`,
            provider: sessionIndex === 2 ? 'wasm' as const : 'webgpu' as const,
            inputNames: ['input'],
            outputNames: ['output'],
          };
        }),
        runInference: vi.fn(async () => ({
          outputs: {
            output: {
              data: new Float32Array([1]),
              dims: [1],
              type: 'float32' as const,
            },
          },
        })),
        disposeSession: vi.fn(async () => undefined),
        disposeAll: vi.fn(async () => undefined),
        runCanary: vi.fn(async () => undefined),
      },
    });

    expect(result).toEqual({ ok: true, provider: 'wasm' });
  });
});
