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
