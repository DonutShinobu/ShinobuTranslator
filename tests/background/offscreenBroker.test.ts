import { describe, expect, it, vi } from 'vitest';
import { OffscreenPipelineBroker } from '../../src/background/localPipeline/offscreenBroker';
import type {
  JsonValue,
  RuntimeChannel,
  RuntimeChannelDisconnectReason,
  RuntimeChannelServer,
} from '../../apps/extension/src/capabilities/contracts';
import {
  createChromePipelineHostLifecycle,
} from '../../apps/extension/src/pipelineHost/chromeLifecycle';
import {
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from '../../apps/extension/src/pipelineHost/contracts';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
} from '../../src/shared/localPipelineProtocol';

class FakePort implements RuntimeChannel {
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: JsonValue) => void> = [];
  readonly disconnectListeners: Array<(
    reason: RuntimeChannelDisconnectReason,
  ) => void> = [];
  disconnected = false;
  failPosts = false;
  beforeSend?: (message: JsonValue) => Promise<void>;
  readonly source: RuntimeChannel['source'];

  constructor(readonly name: string, documentUrl?: string) {
    this.source = documentUrl
      ? { kind: 'extension-document', url: documentUrl }
      : { kind: 'unknown' };
  }

  async send(message: JsonValue): Promise<void> {
    if (this.disconnected) throw new Error('port disconnected');
    if (this.failPosts) throw new Error('post failed');
    await this.beforeSend?.(message);
    this.sent.push(message);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) {
      listener('closed-locally');
    }
  }

  onMessage(listener: (message: JsonValue) => void): () => void {
    this.messageListeners.push(listener);
    return () => {
      const index = this.messageListeners.indexOf(listener);
      if (index >= 0) this.messageListeners.splice(index, 1);
    };
  }

  onDisconnect(
    listener: (reason: RuntimeChannelDisconnectReason) => void,
  ): () => void {
    this.disconnectListeners.push(listener);
    return () => {
      const index = this.disconnectListeners.indexOf(listener);
      if (index >= 0) this.disconnectListeners.splice(index, 1);
    };
  }

  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(message as JsonValue);
    }
  }
}

const runtimeChannels: RuntimeChannelServer = {
  onChannel: () => () => undefined,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createBroker(chromeApi: unknown): OffscreenPipelineBroker {
  return new OffscreenPipelineBroker(
    createChromePipelineHostLifecycle(chromeApi),
    runtimeChannels,
  );
}

const pipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CN',
  translator: 'llm',
  llmProvider: 'openai',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://example.invalid',
  llmApiKey: 'runtime-only',
  llmModel: 'test-model',
  typesetDebug: false,
  eraseDebug: false,
  collectDebugLog: false,
  ocrEngine: 'paddleocr_v6_medium',
  processMode: 'translate',
};

function transferJob(client: FakePort, jobId: string, data = 'YQ=='): void {
  client.emitMessage({
    type: 'start',
    jobId,
    file: {
      name: `${jobId}.png`,
      type: 'image/png',
      size: 1,
      lastModified: 0,
    },
    config: pipelineConfig,
    input: { chunkCount: 1, totalChars: data.length },
  });
  client.emitMessage({ type: 'input-chunk', jobId, index: 0, data });
  client.emitMessage({ type: 'input-complete', jobId });
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
  const chromeApi = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      onConnect: { addListener: () => undefined },
    },
    offscreen: {
      createDocument,
      closeDocument,
    },
  };
  broker = createBroker(chromeApi);
  return { broker, host, createDocument, closeDocument };
}

describe('OffscreenPipelineBroker', () => {
  it('deduplicates concurrent document creation and acknowledges prepares without forwarding queued work', async () => {
    const { broker, host, createDocument } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);

    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });

    await vi.waitFor(() => expect(first.sent).toContainEqual({ type: 'ready', jobId: 'job-1' }));
    expect(second.sent).toContainEqual({ type: 'ready', jobId: 'job-2' });
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'prepare' }));
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('binds a job to its source Port', async () => {
    const { broker } = createHarness();
    const owner = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const intruder = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(owner);
    broker.handlePort(intruder);
    owner.emitMessage({ type: 'prepare', jobId: 'bound-job' });
    await vi.waitFor(() => expect(owner.sent).toContainEqual({ type: 'ready', jobId: 'bound-job' }));

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
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'ready', jobId: 'disconnect-job' }));

    client.disconnect();

    expect(host.sent).not.toContainEqual(expect.objectContaining({ jobId: 'disconnect-job' }));
  });

  it('admits jobs globally in prepare arrival order', async () => {
    const { broker, host } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);
    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });
    await vi.waitFor(() => expect(second.sent).toContainEqual({ type: 'ready', jobId: 'job-2' }));

    transferJob(first, 'job-1');
    transferJob(second, 'job-2');

    expect(host.sent.filter((message) => (
      (message as { jobId?: string }).jobId === 'job-2'
    ))).toEqual([]);
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'job-1' });
      expect(host.sent).toContainEqual({ type: 'input-complete', jobId: 'job-1' });
      expect(second.sent).toContainEqual({
        type: 'queued',
        jobId: 'job-2',
        position: 1,
      });
    });

    host.emitMessage({ type: 'complete', jobId: 'job-1' });

    await vi.waitFor(() => {
      expect(host.sent.filter((message) => (
        (message as { type?: string }).type === 'input-complete'
      ))).toEqual([
        { type: 'input-complete', jobId: 'job-1' },
        { type: 'input-complete', jobId: 'job-2' },
      ]);
    });
  });

  it('does not let a later small transfer overtake an earlier prepared job', async () => {
    const { broker, host } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);
    first.emitMessage({ type: 'prepare', jobId: 'large-first' });
    second.emitMessage({ type: 'prepare', jobId: 'small-second' });
    await vi.waitFor(() => expect(second.sent).toContainEqual({
      type: 'ready',
      jobId: 'small-second',
    }));

    transferJob(second, 'small-second');
    expect(host.sent).not.toContainEqual(expect.objectContaining({
      jobId: 'small-second',
    }));
    await vi.waitFor(() => {
      expect(second.sent).toContainEqual({
        type: 'queued',
        jobId: 'small-second',
        position: 1,
      });
    });

    transferJob(first, 'large-first');
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({
        type: 'input-complete',
        jobId: 'large-first',
      });
    });
    expect(host.sent).not.toContainEqual({
      type: 'input-complete',
      jobId: 'small-second',
    });

    host.emitMessage({ type: 'complete', jobId: 'large-first' });
    await vi.waitFor(() => {
      expect(host.sent.filter((message) => (
        (message as { type?: string }).type === 'input-complete'
      ))).toEqual([
        { type: 'input-complete', jobId: 'large-first' },
        { type: 'input-complete', jobId: 'small-second' },
      ]);
    });
  });

  it('does not expire a fully received job while it waits behind long active work', async () => {
    vi.useFakeTimers();
    try {
      const { broker, host } = createHarness();
      const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
      const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
      broker.handlePort(first);
      broker.handlePort(second);
      first.emitMessage({ type: 'prepare', jobId: 'job-1' });
      second.emitMessage({ type: 'prepare', jobId: 'job-2' });
      await Promise.resolve();
      await Promise.resolve();

      transferJob(first, 'job-1');
      transferJob(second, 'job-2');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(second.sent).not.toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'job-2',
      }));
      host.emitMessage({ type: 'complete', jobId: 'job-1' });
      await vi.waitFor(() => {
        expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'job-2' });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails all owned jobs instead of wedging FIFO when admitted delivery throws', async () => {
    const { broker, host } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);
    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });
    await vi.waitFor(() => expect(second.sent).toContainEqual({ type: 'ready', jobId: 'job-2' }));

    host.failPosts = true;
    transferJob(first, 'job-1');
    transferJob(second, 'job-2');

    await vi.waitFor(() => {
      expect(first.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'job-1',
        error: expect.objectContaining({ code: 'OFFSCREEN_DISCONNECTED' }),
      }));
      expect(second.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'job-2',
        error: expect.objectContaining({ code: 'OFFSCREEN_DISCONNECTED' }),
      }));
    });
  });

  it('does not activate a job until every host message has been delivered', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const delivery = deferred<void>();
    let firstDelivery = true;
    host.beforeSend = async () => {
      if (!firstDelivery) return;
      firstDelivery = false;
      await delivery.promise;
    };
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'delayed-job' });
    await vi.waitFor(() => {
      expect(client.sent).toContainEqual({ type: 'ready', jobId: 'delayed-job' });
    });

    transferJob(client, 'delayed-job');
    await vi.waitFor(() => expect(firstDelivery).toBe(false));
    expect(client.sent).not.toContainEqual({
      type: 'queued',
      jobId: 'delayed-job',
      position: 0,
    });
    expect(host.sent).not.toContainEqual({
      type: 'input-complete',
      jobId: 'delayed-job',
    });

    delivery.resolve(undefined);
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({
        type: 'input-complete',
        jobId: 'delayed-job',
      });
      expect(client.sent).toContainEqual({
        type: 'queued',
        jobId: 'delayed-job',
        position: 0,
      });
    });
  });

  it('resets admission when active cancellation cannot reach the host', async () => {
    const { broker, host } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);
    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });
    await vi.waitFor(() => expect(second.sent).toContainEqual({ type: 'ready', jobId: 'job-2' }));
    transferJob(first, 'job-1');
    transferJob(second, 'job-2');
    await vi.waitFor(() => {
      expect(first.sent).toContainEqual({ type: 'queued', jobId: 'job-1', position: 0 });
    });

    host.failPosts = true;
    first.disconnect();

    await vi.waitFor(() => expect(second.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'job-2',
      error: expect.objectContaining({ code: 'OFFSCREEN_DISCONNECTED' }),
    })));
    expect(host.disconnected).toBe(true);
  });

  it('preserves transport-disconnected cancellation across the background/offscreen seam', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'job-1' });
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'ready', jobId: 'job-1' }));
    transferJob(client, 'job-1');
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({ type: 'input-complete', jobId: 'job-1' });
    });

    client.disconnect();

    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({
        type: 'cancel',
        jobId: 'job-1',
        reason: {
          code: 'transport-disconnected',
          messageKey: 'pipeline.cancelled.transportDisconnected',
          diagnosticSummary: '来源 Port 已断开',
        },
      });
    });
  });

  it('treats an invalid active host message as a broken host connection', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'job-1' });
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'ready', jobId: 'job-1' }));
    transferJob(client, 'job-1');

    host.emitMessage({ type: 'unknown-host-message', jobId: 'job-1' });

    await vi.waitFor(() => {
      expect(client.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'job-1',
        error: expect.objectContaining({ code: 'TRANSFER_PROTOCOL_ERROR' }),
      }));
    });
    expect(host.disconnected).toBe(true);
  });

  it('rejects duplicate buffered chunks before global admission', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'duplicate-job' });
    await vi.waitFor(() => expect(client.sent).toContainEqual({
      type: 'ready',
      jobId: 'duplicate-job',
    }));
    client.emitMessage({
      type: 'start',
      jobId: 'duplicate-job',
      file: { name: 'duplicate.png', type: 'image/png', size: 1, lastModified: 0 },
      config: pipelineConfig,
      input: { chunkCount: 1, totalChars: 4 },
    });
    client.emitMessage({ type: 'input-chunk', jobId: 'duplicate-job', index: 0, data: 'YQ==' });
    client.emitMessage({ type: 'input-chunk', jobId: 'duplicate-job', index: 0, data: 'YQ==' });

    await vi.waitFor(() => {
      expect(client.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'duplicate-job',
        error: expect.objectContaining({ code: 'TRANSFER_PROTOCOL_ERROR' }),
      }));
    });
    expect(host.sent).not.toContainEqual(expect.objectContaining({ jobId: 'duplicate-job' }));
  });

  it('cancels active compute after a late duplicate terminal message', async () => {
    const { broker, host } = createHarness();
    const first = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const second = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(first);
    broker.handlePort(second);
    first.emitMessage({ type: 'prepare', jobId: 'job-1' });
    second.emitMessage({ type: 'prepare', jobId: 'job-2' });
    await vi.waitFor(() => expect(second.sent).toContainEqual({ type: 'ready', jobId: 'job-2' }));
    transferJob(first, 'job-1');
    transferJob(second, 'job-2');
    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({ type: 'input-complete', jobId: 'job-1' });
    });

    first.emitMessage({ type: 'input-complete', jobId: 'job-1' });

    await vi.waitFor(() => {
      expect(host.sent).toContainEqual({
        type: 'cancel',
        jobId: 'job-1',
        reason: {
          code: 'transport-disconnected',
          messageKey: 'pipeline.cancelled.transportDisconnected',
          diagnosticSummary: 'active 任务收到无效传输消息',
        },
      });
    });
    expect(first.sent).not.toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'job-1',
    }));

    host.emitMessage({
      type: 'error',
      jobId: 'job-1',
      error: { name: 'AbortError', code: 'TASK_CANCELLED', message: 'cancelled' },
    });

    await vi.waitFor(() => {
      expect(first.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'job-1',
        error: expect.objectContaining({ code: 'TRANSFER_PROTOCOL_ERROR' }),
      }));
      expect(host.sent).toContainEqual({ type: 'prepare', jobId: 'job-2' });
    });
  });

  it('expires an abandoned input transfer', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = createHarness();
      const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
      broker.handlePort(client);
      client.emitMessage({ type: 'prepare', jobId: 'abandoned-job' });
      await Promise.resolve();
      await Promise.resolve();
      client.emitMessage({
        type: 'start',
        jobId: 'abandoned-job',
        file: { name: 'abandoned.png', type: 'image/png', size: 1, lastModified: 0 },
        config: pipelineConfig,
        input: { chunkCount: 1, totalChars: 4 },
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(client.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'abandoned-job',
        error: expect.objectContaining({ code: 'TRANSFER_PROTOCOL_ERROR' }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an offscreen disconnect to every active source', async () => {
    const { broker, host } = createHarness();
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'active-job' });
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'ready', jobId: 'active-job' }));

    host.disconnect();

    await vi.waitFor(() => {
      expect(client.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'active-job',
        error: expect.objectContaining({ code: 'OFFSCREEN_DISCONNECTED' }),
      }));
    });
  });

  it('closes the document only after the host reports idle with no jobs', async () => {
    const { broker, host, closeDocument } = createHarness();
    broker.handlePort(host);
    host.emitMessage({ type: 'host-ready' });
    host.emitMessage({ type: 'idle-close' });

    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledTimes(1));
  });

  it('closes after a pending idle request once the last background-only transfer expires', async () => {
    vi.useFakeTimers();
    try {
      const { broker, host, closeDocument } = createHarness();
      const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
      broker.handlePort(client);
      client.emitMessage({ type: 'prepare', jobId: 'background-only' });
      await Promise.resolve();
      await Promise.resolve();

      host.emitMessage({ type: 'idle-close' });
      expect(closeDocument).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();

      expect(closeDocument).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit a new prepare onto an offscreen Port that is closing', async () => {
    const close = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const offscreenUrl = 'chrome-extension://test/offscreen.html';
    const firstHost = new FakePort(LOCAL_PIPELINE_OFFSCREEN_PORT, offscreenUrl);
    const secondHost = new FakePort(LOCAL_PIPELINE_OFFSCREEN_PORT, offscreenUrl);
    let documentExists = true;
    let broker!: OffscreenPipelineBroker;
    const createDocument = vi.fn(async () => {
      documentExists = true;
      broker.handlePort(secondHost);
      secondHost.emitMessage({ type: 'host-ready' });
    });
    const closeDocument = vi.fn(async () => {
      await close.promise;
      documentExists = false;
      firstHost.disconnect();
    });
    broker = createBroker({
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts: async () => documentExists
          ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }]
          : [],
      },
      offscreen: { createDocument, closeDocument },
    });
    broker.handlePort(firstHost);
    firstHost.emitMessage({ type: 'host-ready' });
    firstHost.emitMessage({ type: 'idle-close' });
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);

    client.emitMessage({ type: 'prepare', jobId: 'during-close' });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sent).not.toContainEqual({ type: 'ready', jobId: 'during-close' });

    close.resolve();
    await vi.waitFor(() => {
      expect(createDocument).toHaveBeenCalledOnce();
      expect(client.sent).toContainEqual({ type: 'ready', jobId: 'during-close' });
    });
    expect(firstHost.sent).not.toContainEqual(expect.objectContaining({
      jobId: 'during-close',
    }));
  });

  it('keeps the ready host usable when an idle close is rejected', async () => {
    const { broker, host, createDocument, closeDocument } = createHarness();
    closeDocument.mockRejectedValueOnce(new Error('close failed'));
    broker.handlePort(host);
    host.emitMessage({ type: 'host-ready' });

    host.emitMessage({ type: 'idle-close' });
    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledOnce());
    await Promise.resolve();

    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    broker.handlePort(client);
    client.emitMessage({ type: 'prepare', jobId: 'after-failed-close' });

    await vi.waitFor(() => expect(client.sent).toContainEqual({
      type: 'ready',
      jobId: 'after-failed-close',
    }));
    expect(createDocument).not.toHaveBeenCalled();
    expect(host.disconnected).toBe(false);
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
      broker = createBroker({
        runtime: {
          getURL: (path: string) => `chrome-extension://test/${path}`,
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
      expect(client.sent).toContainEqual({ type: 'ready', jobId: 'rebuild-job' });
      expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'prepare' }));
    } finally {
      vi.useRealTimers();
    }
  });
});
