import { describe, expect, it, vi } from 'vitest';
import { OffscreenPipelineBroker } from '../../src/background/localPipeline/offscreenBroker';
import type { ChromeLike, ChromePort } from '../../src/shared/chrome';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from '../../src/shared/localPipelineProtocol';

class FakePort implements ChromePort {
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: unknown, port: ChromePort) => void> = [];
  readonly disconnectListeners: Array<(port: ChromePort) => void> = [];
  disconnected = false;
  sender?: ChromePort['sender'];

  constructor(readonly name: string, documentUrl?: string) {
    this.sender = documentUrl ? { documentUrl } : undefined;
  }

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('port disconnected');
    this.sent.push(message);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener(this);
  }

  onMessage = {
    addListener: (listener: (message: unknown, port: ChromePort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (listener: (message: unknown, port: ChromePort) => void): void => {
      const index = this.messageListeners.indexOf(listener);
      if (index >= 0) this.messageListeners.splice(index, 1);
    },
  };

  onDisconnect = {
    addListener: (listener: (port: ChromePort) => void): void => {
      this.disconnectListeners.push(listener);
    },
    removeListener: (listener: (port: ChromePort) => void): void => {
      const index = this.disconnectListeners.indexOf(listener);
      if (index >= 0) this.disconnectListeners.splice(index, 1);
    },
  };

  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message, this);
  }
}

function createHarness(): {
  broker: OffscreenPipelineBroker;
  host: FakePort;
  createDocument: ReturnType<typeof vi.fn>;
  closeDocument: ReturnType<typeof vi.fn>;
} {
  const offscreenUrl = 'chrome-extension://test/offscreen.html';
  const host = new FakePort(LOCAL_PIPELINE_OFFSCREEN_PORT, offscreenUrl);
  let broker: OffscreenPipelineBroker;
  const createDocument = vi.fn(async () => {
    broker.handlePort(host);
    host.emitMessage({ type: 'host-ready' });
  });
  const closeDocument = vi.fn(async () => undefined);
  const chromeApi: ChromeLike = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      onConnect: { addListener: () => undefined },
    },
    offscreen: {
      createDocument,
      closeDocument,
    },
  };
  broker = new OffscreenPipelineBroker(chromeApi);
  return { broker, host, createDocument, closeDocument };
}

describe('OffscreenPipelineBroker', () => {
  it('deduplicates concurrent document creation and forwards both prepares', async () => {
    const { broker, host, createDocument } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);

    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });

    await vi.waitFor(() => {
      expect(host.sent.filter((message) => (message as { type?: string }).type === 'prepare')).toHaveLength(2);
    });
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('binds a job to its source Port', async () => {
    const { broker } = createHarness();
    const owner = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const intruder = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(owner);
    broker.handlePort(intruder);
    owner.emitMessage({ type: 'prepare', jobId: 'bound-job' });
    await vi.waitFor(() => expect(owner.disconnected).toBe(false));

    intruder.emitMessage({ type: 'input-complete', jobId: 'bound-job' });

    await vi.waitFor(() => {
      expect(intruder.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'bound-job',
        error: expect.objectContaining({ code: 'TRANSFER_PROTOCOL_ERROR' }),
      }));
    });
  });

  it('cancels jobs when the source Port disconnects', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'disconnect-job' });
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'disconnect-job' });
    });

    client.disconnect();

    expect(host.sent).toContainEqual({
      type: 'cancel',
      jobId: 'disconnect-job',
      reason: '来源 Port 已断开',
    });
  });

  it('reports an offscreen disconnect to every active source', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'active-job' });
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'active-job' });
    });

    host.disconnect();

    expect(client.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'active-job',
      error: expect.objectContaining({ code: 'OFFSCREEN_DISCONNECTED' }),
    }));
  });

  it('closes the document only after the host reports idle with no jobs', async () => {
    const { broker, host, closeDocument } = createHarness();
    broker.handlePort(host);
    host.emitMessage({ type: 'host-ready' });
    host.emitMessage({ type: 'idle-close' });

    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledTimes(1));
  });

  it('recreates an existing offscreen document whose host Port never reconnects', async () => {
    vi.useFakeTimers();
    try {
      const offscreenUrl = 'chrome-extension://test/offscreen.html';
      const host = new FakePort(LOCAL_PIPELINE_OFFSCREEN_PORT, offscreenUrl);
      let broker!: OffscreenPipelineBroker;
      const createDocument = vi.fn(async () => {
        broker.handlePort(host);
        host.emitMessage({ type: 'host-ready' });
      });
      const closeDocument = vi.fn(async () => undefined);
      broker = new OffscreenPipelineBroker({
        runtime: {
          getURL: (path) => `chrome-extension://test/${path}`,
          getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }],
        },
        offscreen: { createDocument, closeDocument },
      });
      const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
      broker.handlePort(client);

      client.emitMessage({ type: 'prepare', jobId: 'rebuild-job' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      expect(closeDocument).toHaveBeenCalledTimes(1);
      expect(createDocument).toHaveBeenCalledTimes(1);
      expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'rebuild-job' });
    } finally {
      vi.useRealTimers();
    }
  });
});
