import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelRegistry } from '../../packages/model-runtime/src/runtime/modelRegistry';

const createSession = vi.fn();
const disposeAll = vi.fn(async () => undefined);
const disposeSession = vi.fn(async () => undefined);

describe('ModelRuntime instance session cache', () => {
  beforeEach(() => {
    createSession.mockReset();
    disposeAll.mockClear();
    disposeSession.mockClear();
  });

  it('deduplicates concurrent creation, records provider fallback, and reuses the cache', async () => {
    const runtimeEvents: Array<Record<string, unknown>> = [];
    let resolveCreation!: (value: {
      sessionId: string;
      provider: 'wasm';
      inputNames: string[];
      outputNames: string[];
    }) => void;
    const creation = new Promise<{
      sessionId: string;
      provider: 'wasm';
      inputNames: string[];
      outputNames: string[];
    }>((resolve) => {
      resolveCreation = resolve;
    });
    createSession.mockReturnValue(creation);
    const registry = createModelRegistry({
      environment: 'browser',
      backend: { createSession, disposeAll, disposeSession },
      loadManifest: async () => ({
        models: {
          detector: {
            name: 'detector',
            task: 'detect',
            url: '/models/detector.onnx',
            input: [1, 3, 1024, 1024],
            runtime: ['webnn', 'wasm'],
          },
        },
      }),
      performanceObserver: {
        recordWorkerCall: vi.fn(),
        recordRuntimeEvent: (event) => runtimeEvents.push(event),
      },
    });

    const first = registry.getSession('detector', ['webnn', 'wasm']);
    const second = registry.getSession('detector', ['webnn', 'wasm']);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    resolveCreation({
      sessionId: 'detector-session',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });

    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    const cached = await registry.getSession('detector', ['webnn', 'wasm']);

    expect(firstHandle).toBe(secondHandle);
    expect(cached).toBe(firstHandle);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      'detector',
      '/models/detector.onnx',
      ['webnn', 'wasm'],
      undefined,
    );
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'provider-fallback',
      provider: 'wasm',
    }));
    expect(runtimeEvents.filter((event) => event.kind === 'session-cache-hit')).toHaveLength(2);

    await registry.dispose();
    expect(disposeAll).toHaveBeenCalledTimes(1);
  });

  it('keeps caches isolated between runtime instances', async () => {
    createSession.mockImplementation(async (model: string) => ({
      sessionId: `${model}-${createSession.mock.calls.length}`,
      provider: 'wasm' as const,
      inputNames: ['input'],
      outputNames: ['output'],
    }));
    const options = {
      environment: 'browser' as const,
      backend: { createSession, disposeAll, disposeSession },
      loadManifest: async () => ({
        models: {
          detector: {
            name: 'detector',
            task: 'detect',
            url: '/models/detector.onnx',
            input: [1, 3, 1024, 1024],
          },
        },
      }),
    };
    const first = createModelRegistry(options);
    const second = createModelRegistry(options);

    await first.getSession('detector');
    await first.getSession('detector');
    await second.getSession('detector');

    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('uses the verified cold-start Session defaults only for the browser detector', async () => {
    createSession.mockImplementation(async (model: string) => ({
      sessionId: `${model}-session`,
      provider: 'webgpu' as const,
      inputNames: ['input'],
      outputNames: ['output'],
    }));
    const registry = createModelRegistry({
      environment: 'browser',
      backend: { createSession, disposeAll, disposeSession },
      loadManifest: async () => ({
        models: {
          detector: {
            name: 'detector',
            task: 'detect',
            url: '/models/detector.ort',
            format: 'ort',
            input: [1, 3, 1024, 1024],
            runtime: ['webgpu', 'wasm'],
          },
          bubble: {
            name: 'bubble',
            task: 'segment',
            url: '/models/bubble.onnx',
            input: [1, 3, 640, 640],
            runtime: ['webgpu', 'wasm'],
          },
        },
      }),
    });

    await registry.getSession('detector');
    await registry.getSession('bubble');

    expect(createSession).toHaveBeenNthCalledWith(
      1,
      'detector',
      '/models/detector.ort',
      ['webgpu', 'wasm'],
      {
        graphOptimizationLevel: 'extended',
        useOrtModelBytesForInitializers: true,
      },
    );
    expect(createSession).toHaveBeenNthCalledWith(
      2,
      'bubble',
      '/models/bubble.onnx',
      ['webgpu', 'wasm'],
      undefined,
    );
  });

  it('keeps detector Sessions with different cold-start options in separate cache entries', async () => {
    createSession.mockImplementation(async () => ({
      sessionId: `detector-${createSession.mock.calls.length}`,
      provider: 'webgpu' as const,
      inputNames: ['input'],
      outputNames: ['output'],
    }));
    const registry = createModelRegistry({
      environment: 'browser',
      backend: { createSession, disposeAll, disposeSession },
      loadManifest: async () => ({
        models: {
          detector: {
            name: 'detector',
            task: 'detect',
            url: '/models/detector.ort',
            format: 'ort',
            input: [1, 3, 1024, 1024],
            runtime: ['webgpu', 'wasm'],
          },
        },
      }),
    });

    const optimized = await registry.getSession('detector');
    const baseline = await registry.getSession('detector', undefined, {
      graphOptimizationLevel: 'all',
      useOrtModelBytesForInitializers: false,
    });
    const optimizedAgain = await registry.getSession('detector');
    const baselineAgain = await registry.getSession('detector', undefined, {
      graphOptimizationLevel: 'all',
      useOrtModelBytesForInitializers: false,
    });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(optimizedAgain).toBe(optimized);
    expect(baselineAgain).toBe(baseline);
    expect(baseline).not.toBe(optimized);
  });
});
