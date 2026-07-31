import { describe, expect, it, vi } from 'vitest';
import type {
  JsonValue,
  RuntimeChannel,
  RuntimeChannelDisconnectReason,
} from '../../apps/extension/src/capabilities/contracts';
import {
  createChromePipelineHostLifecycle,
} from '../../apps/extension/src/pipelineHost/chromeLifecycle';
import {
  createFirefoxPipelineHostLifecycle,
} from '../../apps/extension/src/pipelineHost/firefoxLifecycle';
import {
  LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from '../../apps/extension/src/pipelineHost/contracts';

function listenerEvent<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener(listener: T): void {
      listeners.add(listener);
    },
    removeListener(listener: T): void {
      listeners.delete(listener);
    },
    emit(...args: Parameters<T>): void {
      for (const listener of listeners) listener(...args);
    },
  };
}

function rawPort() {
  const onMessage = listenerEvent<(message: unknown) => void>();
  const onDisconnect = listenerEvent<() => void>();
  return {
    name: LOCAL_PIPELINE_OFFSCREEN_PORT,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => onDisconnect.emit()),
    onMessage,
    onDisconnect,
  };
}

function channel(
  name: string,
  source: RuntimeChannel['source'],
): RuntimeChannel {
  return {
    name,
    source,
    send: vi.fn(async (_message: JsonValue) => undefined),
    onMessage: vi.fn(() => () => undefined),
    onDisconnect: vi.fn(
      (_listener: (reason: RuntimeChannelDisconnectReason) => void) => (
        () => undefined
      ),
    ),
    disconnect: vi.fn(async () => undefined),
  };
}

describe('Chrome PipelineHostLifecycle', () => {
  it('owns only the Offscreen document and host-channel lifecycle', async () => {
    const port = rawPort();
    const createDocument = vi.fn(async () => undefined);
    const closeDocument = vi.fn(async () => undefined);
    const getContexts = vi.fn(async () => []);
    const connect = vi.fn(() => port);
    const lifecycle = createChromePipelineHostLifecycle({
      runtime: {
        id: 'test-extension',
        connect,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts,
      },
      offscreen: {
        createDocument,
        closeDocument,
      },
    });

    expect(lifecycle.isAvailable()).toBe(true);
    await expect(lifecycle.exists()).resolves.toBe(false);
    await expect(lifecycle.connect()).resolves.toMatchObject({
      name: LOCAL_PIPELINE_OFFSCREEN_PORT,
    });
    await lifecycle.create();
    await expect(lifecycle.close()).resolves.toBe(true);

    expect(connect).toHaveBeenCalledWith({
      name: LOCAL_PIPELINE_OFFSCREEN_PORT,
    });
    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [
        `chrome-extension://test/${LOCAL_PIPELINE_OFFSCREEN_DOCUMENT}`,
      ],
    });
    expect(createDocument).toHaveBeenCalledWith({
      url: LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
      reasons: ['WORKERS'],
      justification: '在扩展同源上下文中运行本地 ONNX 图片翻译流水线',
    });
    expect(closeDocument).toHaveBeenCalledTimes(1);

    expect(lifecycle.accepts(channel(
      LOCAL_PIPELINE_OFFSCREEN_PORT,
      {
        kind: 'extension-document',
        url: `chrome-extension://test/${LOCAL_PIPELINE_OFFSCREEN_DOCUMENT}`,
      },
    ))).toBe(true);
    expect(lifecycle.accepts(channel(
      LOCAL_PIPELINE_OFFSCREEN_PORT,
      {
        kind: 'tab-document',
        documentId: 'document-1',
        tabId: 1,
        frameId: 0,
      },
    ))).toBe(false);
    expect(lifecycle.accepts(channel(
      'other-channel',
      {
        kind: 'extension-document',
        url: `chrome-extension://test/${LOCAL_PIPELINE_OFFSCREEN_DOCUMENT}`,
      },
    ))).toBe(false);
  });
});

describe('Firefox Event Page PipelineHostLifecycle', () => {
  it('activates one direct host after its broker channel is attached and disposes it once', async () => {
    const hostMessages: JsonValue[] = [];
    const brokerMessages: JsonValue[] = [];
    const disconnectReasons: RuntimeChannelDisconnectReason[] = [];
    const dispose = vi.fn(async () => undefined);
    const startHost = vi.fn((connection) => {
      void connection.connect().then((hostChannel: RuntimeChannel) => {
        hostChannel.onMessage((message) => {
          hostMessages.push(message);
        });
        hostChannel.onDisconnect((reason) => {
          disconnectReasons.push(reason);
        });
        void hostChannel.send({ type: 'host-ready' });
      });
      return { dispose };
    });
    const lifecycle = createFirefoxPipelineHostLifecycle(startHost);

    expect(lifecycle.isAvailable()).toBe(true);
    await expect(lifecycle.exists()).resolves.toBe(false);

    const activation = await lifecycle.create();
    expect(activation).toBeDefined();
    expect(startHost).not.toHaveBeenCalled();
    activation?.channel.onMessage((message) => {
      brokerMessages.push(message);
    });
    activation?.activate();

    await vi.waitFor(() => {
      expect(brokerMessages).toEqual([{ type: 'host-ready' }]);
    });
    expect(startHost).toHaveBeenCalledOnce();
    await expect(lifecycle.exists()).resolves.toBe(true);

    await activation?.channel.send({
      type: 'prepare',
      jobId: 'firefox-direct-job',
    });
    expect(hostMessages).toEqual([{
      type: 'prepare',
      jobId: 'firefox-direct-job',
    }]);

    await expect(lifecycle.close()).resolves.toBe(true);
    await expect(lifecycle.close()).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(disconnectReasons).toEqual(['peer-disconnected']);
    await expect(lifecycle.exists()).resolves.toBe(false);
  });

  it('waits for an asynchronously loaded host before closing it', async () => {
    const dispose = vi.fn(async () => undefined);
    let resolveHost: ((controller: { dispose(): Promise<void> }) => void)
      | undefined;
    const startHost = vi.fn(() => new Promise<{ dispose(): Promise<void> }>(
      (resolve) => {
        resolveHost = resolve;
      },
    ));
    const lifecycle = createFirefoxPipelineHostLifecycle(startHost);
    const activation = await lifecycle.create();

    activation?.activate();
    await vi.waitFor(() => {
      expect(startHost).toHaveBeenCalledOnce();
    });
    const closing = lifecycle.close();
    expect(dispose).not.toHaveBeenCalled();

    resolveHost?.({ dispose });

    await expect(closing).resolves.toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases a lost direct host before rebuilding for the next task', async () => {
    const disposals = [
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ];
    const startHost = vi.fn(() => ({
      dispose: disposals[startHost.mock.calls.length - 1]!,
    }));
    const lifecycle = createFirefoxPipelineHostLifecycle(startHost);
    const first = await lifecycle.create();

    first?.activate();
    await vi.waitFor(() => {
      expect(startHost).toHaveBeenCalledOnce();
    });
    await first?.channel.disconnect();

    await vi.waitFor(() => {
      expect(disposals[0]).toHaveBeenCalledOnce();
    });
    await expect(lifecycle.exists()).resolves.toBe(false);

    const second = await lifecycle.create();
    expect(second).toBeDefined();
    second?.activate();
    await vi.waitFor(() => {
      expect(startHost).toHaveBeenCalledTimes(2);
    });

    await expect(lifecycle.close()).resolves.toBe(true);
    expect(disposals[0]).toHaveBeenCalledOnce();
    expect(disposals[1]).toHaveBeenCalledOnce();
  });
});
