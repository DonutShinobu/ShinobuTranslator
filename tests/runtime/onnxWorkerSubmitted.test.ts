import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpuDetectResult } from '../../packages/model-runtime/src/runtime/onnxWorkerTypes';

type WireMessage = { id: string; type: string; path?: string[]; argumentList?: unknown[] };

class MessageWorker {
  static instances: MessageWorker[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly posts: Array<{ message: WireMessage; transfers: unknown }> = [];
  detectorMessage: WireMessage | null = null;
  detectorPostError: Error | null = null;

  constructor() { MessageWorker.instances.push(this); }
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
  postMessage(message: WireMessage, transfers?: unknown): void {
    const method = message.path?.at(-1);
    if (method === 'runDetectWithGpuPreprocess' && this.detectorPostError) throw this.detectorPostError;
    this.posts.push({ message, transfers });
    if (method === 'runDetectWithGpuPreprocess') { this.detectorMessage = message; return; }
    this.reply(message.id, { type: 'RAW', value: method === 'createSession' ? {
      sessionId: 'detector-session', provider: 'webgpu', inputNames: ['images'], outputNames: ['output'],
    } : undefined });
  }
  reply(id: string, value: Record<string, unknown>): void {
    queueMicrotask(() => {
      for (const listener of [...this.listeners.get('message') ?? []]) listener({ data: { id, ...value } });
    });
  }
  terminate(): void {}
}

describe('detector Comlink submission hook', () => {
  const originalWorker = globalThis.Worker;
  beforeEach(() => {
    vi.resetModules();
    MessageWorker.instances = [];
    globalThis.Worker = MessageWorker as unknown as typeof Worker;
  });
  afterEach(async () => {
    const bridge = await import('../../packages/model-runtime/src/runtime/onnxWorkerBridge');
    await bridge.disposeAll();
    globalThis.Worker = originalWorker;
  });

  async function prepare() {
    const bridge = await import('../../packages/model-runtime/src/runtime/onnxWorkerBridge');
    bridge.configureOnnxWorkerBootstrap({
      scriptUrl: 'chrome-extension://test/onnxWorker.js', ortPath: 'chrome-extension://test/ort/', policy: 'direct-only',
    });
    await bridge.createSession('detector', 'chrome-extension://test/detector.ort', ['webgpu']);
    return { bridge, worker: MessageWorker.instances[0]! };
  }

  it('fires after real Comlink posts the unchanged image transfer, before the result arrives', async () => {
    const { bridge, worker } = await prepare();
    const image = {} as ImageBitmap;
    const onSubmitted = vi.fn(() => {
      expect(worker.posts.at(-1)?.message.path).toEqual(['runDetectWithGpuPreprocess']);
      expect(worker.posts.at(-1)?.transfers).toEqual([image]);
      expect(worker.postMessage).toBe(MessageWorker.prototype.postMessage);
    });
    const result = bridge.runDetectWithGpuPreprocess('detector-session', image, onSubmitted);
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    const expected: GpuDetectResult = { outputs: {}, ratio: 1, unpaddedWidth: 1, unpaddedHeight: 1 };
    worker.reply(worker.detectorMessage!.id, { type: 'RAW', value: expected });
    expect(await result).toEqual(expected);
  });

  it('does not signal submission when postMessage throws, and restores the endpoint', async () => {
    const { bridge, worker } = await prepare();
    worker.detectorPostError = new Error('DataCloneError');
    const onSubmitted = vi.fn();
    await expect(bridge.runDetectWithGpuPreprocess('detector-session', {} as ImageBitmap, onSubmitted))
      .rejects.toThrow('DataCloneError');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(worker.postMessage).toBe(MessageWorker.prototype.postMessage);
  });

  it('keeps the RPC rejection handled if the scheduling callback throws', async () => {
    const { bridge, worker } = await prepare();
    const onSubmitted = vi.fn(() => { throw new Error('observer failed'); });
    const result = bridge.runDetectWithGpuPreprocess('detector-session', {} as ImageBitmap, onSubmitted);
    const failure = expect(result).rejects.toThrow('real inference failed');
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    worker.reply(worker.detectorMessage!.id, {
      type: 'HANDLER', name: 'throw', value: { isError: true, value: { name: 'Error', message: 'real inference failed' } },
    });
    await failure;
    expect(worker.postMessage).toBe(MessageWorker.prototype.postMessage);
  });
});
