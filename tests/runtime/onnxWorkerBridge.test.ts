import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const comlinkState = vi.hoisted(() => ({
  releaseProxy: Symbol('releaseProxy'),
  factory: (_worker: unknown): Record<PropertyKey, unknown> => ({}),
}));

vi.mock('comlink', () => ({
  wrap: (worker: unknown) => comlinkState.factory(worker),
  transfer: <T>(value: T) => value,
  releaseProxy: comlinkState.releaseProxy,
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  terminated = false;

  constructor(readonly url: string, readonly options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function sessionHandle() {
  return {
    sessionId: 'detector-session',
    provider: 'wasm' as const,
    inputNames: ['images'],
    outputNames: ['output'],
  };
}

function proxy(init: () => Promise<void>) {
  return {
    init,
    createSession: vi.fn(async () => sessionHandle()),
    runInference: vi.fn(),
    probeRuntime: vi.fn(),
    probePaddleGraphCapture: vi.fn(),
    runDetectWithGpuPreprocess: vi.fn(),
    disposeSession: vi.fn(async () => undefined),
    disposeAll: vi.fn(async () => undefined),
    [comlinkState.releaseProxy]: vi.fn(),
  };
}

describe('onnxWorkerBridge bootstrap policy', () => {
  const originalWorker = globalThis.Worker;
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    FakeWorker.instances = [];
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(async () => {
    try {
      const bridge = await import('../../src/runtime/onnxWorkerBridge');
      await bridge.disposeAll();
    } catch {
      // A failed bootstrap may leave no bridge resources to dispose.
    }
    globalThis.Worker = originalWorker;
    globalThis.fetch = originalFetch;
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses only the direct extension Worker in production extension context', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    comlinkState.factory = () => proxy(async () => undefined);
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    await bridge.createSession('detector', '/models/detector.onnx', ['wasm']);

    expect(FakeWorker.instances.map((worker) => worker.url)).toEqual([
      'chrome-extension://test/onnxWorker.js',
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('normalizes root-relative Worker and ORT paths in a Web page', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal('location', new URL('https://app.example/workbench'));
    const init = vi.fn(async () => undefined);
    const workerProxy = proxy(init);
    comlinkState.factory = () => workerProxy;
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    await bridge.createSession('detector', '/models/detector.onnx', ['wasm']);

    expect(FakeWorker.instances.map((worker) => worker.url)).toEqual([
      'https://app.example/onnxWorker.js',
    ]);
    expect(init).toHaveBeenCalledWith('https://app.example/ort/');
  });

  it('uses a Vite-provided Worker URL in the Web application', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal('location', new URL('https://app.example/workbench'));
    const init = vi.fn(async () => undefined);
    comlinkState.factory = () => proxy(init);
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    bridge.configureOnnxWorkerBootstrap({
      scriptUrl: '/src/workers/onnx-worker.ts?worker_file&type=module',
      ortPath: '/ort/',
    });
    await bridge.createSession('detector', '/models/detector.onnx', ['wasm']);

    expect(FakeWorker.instances.map((worker) => worker.url)).toEqual([
      'https://app.example/src/workers/onnx-worker.ts?worker_file&type=module',
    ]);
    expect(init).toHaveBeenCalledWith('https://app.example/ort/');
  });

  it('does not fall back to Blob when the direct extension Worker fails', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    comlinkState.factory = () => proxy(async () => { throw new Error('extension CSP failure'); });
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    const error = await bridge.createSession('detector', '/models/detector.onnx', ['wasm'])
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(bridge.WorkerBootstrapError);
    expect((error as InstanceType<typeof bridge.WorkerBootstrapError>).attempts).toMatchObject([
      { mode: 'direct-extension', status: 'failed' },
    ]);
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps the Blob URL alive until HTTP fallback initialization completes', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (path: string) => `http://127.0.0.1:4173/${path}` },
    };
    const initGate: { resolve?: () => void } = {};
    const blobInit = new Promise<void>((resolve) => {
      initGate.resolve = resolve;
    });
    comlinkState.factory = (worker) => {
      const fake = worker as FakeWorker;
      return fake.url.startsWith('blob:')
        ? proxy(() => blobInit)
        : proxy(async () => { throw new Error('direct HTTP blocked'); });
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'self.onmessage = () => undefined;',
    })) as unknown as typeof fetch;
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-worker');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    const creation = bridge.createSession('detector', '/models/detector.onnx', ['wasm']);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    initGate.resolve?.();
    await creation;

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-worker');
    expect(FakeWorker.instances.map((worker) => worker.url)).toEqual([
      'http://127.0.0.1:4173/onnxWorker.js',
      'blob:test-worker',
    ]);
  });

  it('aggregates both HTTP bootstrap failures and checks the script response status', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (path: string) => `http://127.0.0.1:4173/${path}` },
    };
    comlinkState.factory = () => proxy(async () => { throw new Error('direct init failed'); });
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    })) as unknown as typeof fetch;
    const bridge = await import('../../src/runtime/onnxWorkerBridge');

    const error = await bridge.createSession('detector', '/models/detector.onnx', ['wasm'])
      .then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(bridge.WorkerBootstrapError);
    expect((error as InstanceType<typeof bridge.WorkerBootstrapError>).attempts).toHaveLength(2);
    expect((error as Error).message).toContain('HTTP 404 Not Found');
  });
});
