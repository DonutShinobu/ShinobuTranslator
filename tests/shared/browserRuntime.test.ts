import { describe, expect, it, vi } from 'vitest';
import {
  attachWorkerTranslatorHost,
  createWorkerTranslatorCore,
  type WorkerClientEndpoint,
  type WorkerHostEndpoint,
} from '@shinobu/browser-runtime';
import {
  TranslationCancelledError,
  TranslationExecutionError,
} from '@shinobu/translator-core';

type MessageHandler = (event: { data: unknown }) => void;
type ErrorHandler = (event: { error?: unknown; message?: string }) => void;

class MemoryEndpoint {
  peer?: MemoryEndpoint;
  terminated = false;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  postMessage(message: unknown): void {
    if (this.terminated) throw new Error('endpoint terminated');
    queueMicrotask(() => {
      for (const handler of this.peer?.messageHandlers ?? []) {
        handler({ data: message });
      }
    });
  }

  addEventListener(type: 'message' | 'error', listener: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.messageHandlers.add(listener as MessageHandler);
    else this.errorHandlers.add(listener as ErrorHandler);
  }

  removeEventListener(type: 'message' | 'error', listener: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.messageHandlers.delete(listener as MessageHandler);
    else this.errorHandlers.delete(listener as ErrorHandler);
  }

  terminate(): void {
    this.terminated = true;
    this.messageHandlers.clear();
    this.errorHandlers.clear();
  }
}

function createEndpointPair(): {
  client: WorkerClientEndpoint & MemoryEndpoint;
  host: WorkerHostEndpoint;
} {
  const client = new MemoryEndpoint();
  const host = new MemoryEndpoint();
  client.peer = host;
  host.peer = client;
  return {
    client: client as unknown as WorkerClientEndpoint & MemoryEndpoint,
    host: host as unknown as WorkerHostEndpoint,
  };
}

describe('browser Worker translator Adapter contract', () => {
  it('forwards requests, progress, and results across the Worker seam', async () => {
    const endpoints = createEndpointPair();
    const detach = attachWorkerTranslatorHost<string, number, string, string>({
      endpoint: endpoints.host,
      async execute({ input, config }, { reportProgress }) {
        reportProgress('running');
        return `${input}:${config}`;
      },
    });
    const core = createWorkerTranslatorCore<string, number, string, string>({
      createWorker: () => endpoints.client,
    });
    const task = core.run({ input: 'page', config: 4 });
    const progress = vi.fn();
    task.progress(progress);

    await expect(task.result).resolves.toBe('page:4');
    expect(progress).toHaveBeenCalledWith('running');

    await core.dispose();
    detach();
  });

  it('propagates cancellation to the active Worker execution', async () => {
    const endpoints = createEndpointPair();
    const aborted = vi.fn();
    const started = vi.fn();
    const detach = attachWorkerTranslatorHost<null, null, never, never>({
      endpoint: endpoints.host,
      async execute(_request, { signal }) {
        started();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted();
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, never>({
      createWorker: () => endpoints.client,
    });
    const task = core.run({ input: null, config: null });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

    task.cancel(new Error('stop'));

    await expect(task.result).rejects.toThrow('stop');
    await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());

    await core.dispose();
    detach();
  });

  it('preserves structured cancellation reasons across the Worker seam', async () => {
    const endpoints = createEndpointPair();
    let hostReason: unknown;
    const started = vi.fn();
    const detach = attachWorkerTranslatorHost<null, null, never, never>({
      endpoint: endpoints.host,
      async execute(_request, { signal }) {
        started();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            hostReason = signal.reason;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, never>({
      createWorker: () => endpoints.client,
    });
    const task = core.run({ input: null, config: null });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const reason = {
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
      diagnosticSummary: 'workbench closed',
    };

    task.cancel(reason);

    await expect(task.result).rejects.toMatchObject({ reason });
    await vi.waitFor(() => {
      expect(hostReason).toBeInstanceOf(TranslationCancelledError);
      expect(hostReason).toMatchObject({ reason });
    });

    await core.dispose();
    detach();
  });

  it('serializes overlapping client work before the one-task Worker host', async () => {
    const endpoints = createEndpointPair();
    let finishFirst: (() => void) | undefined;
    const detach = attachWorkerTranslatorHost<number, null, never, number>({
      endpoint: endpoints.host,
      execute: ({ input }) => (
        input === 1
          ? new Promise<number>((resolve) => {
              finishFirst = () => resolve(1);
            })
          : Promise.resolve(input)
      ),
    });
    const core = createWorkerTranslatorCore<number, null, never, number>({
      createWorker: () => endpoints.client,
    });
    const first = core.run({ input: 1, config: null });
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    const second = core.run({ input: 2, config: null });

    finishFirst?.();
    await expect(first.result).resolves.toBe(1);
    await expect(second.result).resolves.toBe(2);

    await core.dispose();
    detach();
  });

  it('does not admit the next task until cancelled Worker cleanup completes', async () => {
    const endpoints = createEndpointPair();
    const inputs: number[] = [];
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const detach = attachWorkerTranslatorHost<number, null, never, number>({
      endpoint: endpoints.host,
      async execute({ input }, { signal }) {
        inputs.push(input);
        if (input !== 1) return input;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanup;
        throw signal.reason;
      },
    });
    const core = createWorkerTranslatorCore<number, null, never, number>({
      createWorker: () => endpoints.client,
    });
    const first = core.run({ input: 1, config: null });
    await vi.waitFor(() => expect(inputs).toEqual([1]));

    first.cancel(new Error('stop'));
    await expect(first.result).rejects.toThrow('stop');
    const second = core.run({ input: 2, config: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(inputs).toEqual([1]);

    releaseCleanup?.();
    await expect(second.result).resolves.toBe(2);
    expect(inputs).toEqual([1, 2]);

    await core.dispose();
    detach();
  });

  it('waits for the Worker host dispose acknowledgement before terminating it', async () => {
    const endpoints = createEndpointPair();
    let releaseDisposal: (() => void) | undefined;
    const disposal = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const disposeStarted = vi.fn();
    const detach = attachWorkerTranslatorHost<null, null, never, null>({
      endpoint: endpoints.host,
      async execute() {
        return null;
      },
      async dispose() {
        disposeStarted();
        await disposal;
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, null>({
      createWorker: () => endpoints.client,
    });
    await core.run({ input: null, config: null }).result;

    const disposePromise = core.dispose();
    await vi.waitFor(() => expect(disposeStarted).toHaveBeenCalledOnce());
    expect(endpoints.client.terminated).toBe(false);

    releaseDisposal?.();
    await disposePromise;
    expect(endpoints.client.terminated).toBe(true);
    detach();
  });

  it('cancels active public work with owner-ended and waits for Worker cleanup on dispose', async () => {
    const endpoints = createEndpointPair();
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const started = vi.fn();
    const detach = attachWorkerTranslatorHost<null, null, never, never>({
      endpoint: endpoints.host,
      async execute(_request, { signal }) {
        started();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanup;
        throw signal.reason;
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, never>({
      createWorker: () => endpoints.client,
    });
    const task = core.run({ input: null, config: null });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

    const disposal = core.dispose(new Error('workbench closed'));

    expect(task.signal).toMatchObject({ aborted: true });
    await expect(task.result).rejects.toMatchObject({
      reason: {
        code: 'owner-ended',
        messageKey: 'translation.cancelled.ownerEnded',
        diagnosticSummary: 'workbench closed',
      },
    });
    expect(endpoints.client.terminated).toBe(false);

    releaseCleanup?.();
    await disposal;
    expect(endpoints.client.terminated).toBe(true);
    detach();
  });

  it('terminates and rejects when Worker host cleanup fails', async () => {
    const endpoints = createEndpointPair();
    const detach = attachWorkerTranslatorHost<null, null, never, null>({
      endpoint: endpoints.host,
      async execute() {
        return null;
      },
      async dispose() {
        throw new Error('cleanup failed');
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, null>({
      createWorker: () => endpoints.client,
    });
    await core.run({ input: null, config: null }).result;

    await expect(core.dispose()).rejects.toThrow('cleanup failed');
    expect(endpoints.client.terminated).toBe(true);
    detach();
  });

  it('preserves the shared failure envelope through the default Worker serializer', async () => {
    const endpoints = createEndpointPair();
    const detach = attachWorkerTranslatorHost<null, null, never, never>({
      endpoint: endpoints.host,
      async execute() {
        throw new TranslationExecutionError({
          code: 'IMAGE_DECODE_FAILED',
          stage: 'load',
          scope: 'image',
          retryable: false,
          messageKey: 'pipeline.failure.imageLoad',
          diagnostics: { format: 'image/avif' },
        });
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, never>({
      createWorker: () => endpoints.client,
    });

    await expect(core.run({ input: null, config: null }).result).rejects.toMatchObject({
      code: 'IMAGE_DECODE_FAILED',
      stage: 'load',
      scope: 'image',
      retryable: false,
      messageKey: 'pipeline.failure.imageLoad',
      diagnostics: { format: 'image/avif' },
    });

    await core.dispose();
    detach();
  });

  it('rejects a Worker result that fails the adapter schema validator', async () => {
    const endpoints = createEndpointPair();
    const detach = attachWorkerTranslatorHost<null, null, never, { ok: boolean }>({
      endpoint: endpoints.host,
      async execute() {
        return { ok: false };
      },
    });
    const core = createWorkerTranslatorCore<null, null, never, { ok: true }>({
      createWorker: () => endpoints.client,
      validateResult(value) {
        return Boolean(
          value
          && typeof value === 'object'
          && 'ok' in value
          && value.ok === true,
        );
      },
    });

    await expect(core.run({ input: null, config: null }).result).rejects.toMatchObject({
      code: 'WORKER_INVALID_RESULT',
    });

    await core.dispose();
    detach();
  });
});
