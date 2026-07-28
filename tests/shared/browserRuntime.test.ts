import { describe, expect, it, vi } from 'vitest';
import {
  attachWorkerTranslatorHost,
  createWorkerTranslatorCore,
  type WorkerClientEndpoint,
  type WorkerHostEndpoint,
} from '@shinobu/browser-runtime';

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
  client: WorkerClientEndpoint;
  host: WorkerHostEndpoint;
} {
  const client = new MemoryEndpoint();
  const host = new MemoryEndpoint();
  client.peer = host;
  host.peer = client;
  return {
    client: client as unknown as WorkerClientEndpoint,
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

    core.dispose();
    detach();
  });

  it('propagates cancellation to the active Worker execution', async () => {
    const endpoints = createEndpointPair();
    const aborted = vi.fn();
    const detach = attachWorkerTranslatorHost<null, null, never, never>({
      endpoint: endpoints.host,
      async execute(_request, { signal }) {
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
    await Promise.resolve();

    task.cancel(new Error('stop'));

    await expect(task.result).rejects.toThrow('stop');
    await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());

    core.dispose();
    detach();
  });

  it('rejects overlapping work when the host memory limit is one task', async () => {
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
    await Promise.resolve();
    await Promise.resolve();
    const second = core.run({ input: 2, config: null });

    await expect(second.result).rejects.toMatchObject({
      name: 'WorkerBusyError',
      code: 'WORKER_BUSY',
    });
    finishFirst?.();
    await expect(first.result).resolves.toBe(1);

    core.dispose();
    detach();
  });
});
