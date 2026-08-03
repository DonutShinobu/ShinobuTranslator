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
});
