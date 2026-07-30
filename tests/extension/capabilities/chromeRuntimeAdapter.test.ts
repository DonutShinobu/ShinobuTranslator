import { describe, expect, it } from 'vitest';
import {
  createChromeContentCapabilities,
} from '../../../apps/extension/src/capabilities/chromeAdapter';
import type {
  ExtensionMessageSource,
  JsonValue,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  runRuntimeAdapterContract,
  type RuntimeAdapterContractDriver,
} from './runtimeAdapterContract.fixture';
import { ExtensionContractError } from '../../../apps/extension/src/capabilities/errors';

type RawSender = {
  documentId?: string;
  documentUrl?: string;
  frameId?: number;
  origin?: string;
  tab?: {
    id?: number;
    windowId?: number;
    url?: string;
  };
};

type RawRequestListener = (
  request: unknown,
  sender: RawSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

function rawSender(source: ExtensionMessageSource): RawSender {
  if (source.kind === 'tab-document') {
    return {
      documentId: source.documentId,
      documentUrl: source.url,
      frameId: source.frameId,
      tab: {
        id: source.tabId,
        windowId: source.windowId,
        url: source.url,
      },
    };
  }
  if (source.kind === 'extension-document') {
    return {
      documentId: source.documentId,
      documentUrl: source.url,
      origin: 'chrome-extension://extension-id',
      tab: {
        id: 91,
        url: source.url,
      },
    };
  }
  return {};
}

function createChromeDriver(): RuntimeAdapterContractDriver {
  let response: JsonValue | undefined;
  let rejection: Error | undefined;
  let unavailable = false;
  let removedListeners = 0;
  const sent: unknown[] = [];
  const sentChannel: unknown[] = [];
  const listeners = new Set<RawRequestListener>();
  const channelMessageListeners = new Set<(message: unknown) => void>();
  const channelDisconnectListeners = new Set<() => void>();
  let removedChannelMessageListeners = 0;
  let rawChannelDisconnects = 0;
  const port = {
    name: 'pipeline',
    sender: undefined,
    postMessage(message: unknown): void {
      sentChannel.push(message);
    },
    disconnect(): void {
      rawChannelDisconnects += 1;
    },
    onMessage: {
      addListener(listener: (message: unknown) => void): void {
        channelMessageListeners.add(listener);
      },
      removeListener(listener: (message: unknown) => void): void {
        if (channelMessageListeners.delete(listener)) {
          removedChannelMessageListeners += 1;
        }
      },
    },
    onDisconnect: {
      addListener(listener: () => void): void {
        channelDisconnectListeners.add(listener);
      },
      removeListener(listener: () => void): void {
        channelDisconnectListeners.delete(listener);
      },
    },
  };
  const runtime = {
    id: 'extension-id',
    lastError: undefined as { message?: string } | undefined,
    getManifest: () => ({ version: '0.8.1' }),
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    sendMessage: (
      request: unknown,
      callback: (actualResponse: unknown) => void,
    ): void => {
      sent.push(request);
      if (unavailable) {
        runtime.lastError = {
          message: 'Could not establish connection. Receiving end does not exist.',
        };
        callback(undefined);
        runtime.lastError = undefined;
        unavailable = false;
        return;
      }
      if (rejection) {
        runtime.lastError = { message: rejection.message };
        callback(undefined);
        runtime.lastError = undefined;
        rejection = undefined;
        return;
      }
      callback(response);
    },
    onMessage: {
      addListener(listener: RawRequestListener): void {
        listeners.add(listener);
      },
      removeListener(listener: RawRequestListener): void {
        if (listeners.delete(listener)) removedListeners += 1;
      },
    },
    connect: () => port,
    onConnect: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
  };
  const capabilities = createChromeContentCapabilities({ runtime });

  return {
    capabilities,
    respondWith(value) {
      response = value;
    },
    makeNextRequestUnavailable() {
      unavailable = true;
    },
    rejectNextRequest(error) {
      rejection = error;
    },
    async dispatchRequest(request, source) {
      const listener = [...listeners][0];
      if (!listener) return undefined;
      return await new Promise<JsonValue | undefined>((resolve) => {
        listener(request, rawSender(source), (value) => {
          resolve(value as JsonValue | undefined);
        });
      });
    },
    removedRequestListeners() {
      return removedListeners;
    },
    sentRequests() {
      return [...sent];
    },
    emitChannelMessage(message) {
      for (const listener of channelMessageListeners) listener(message);
    },
    emitChannelDisconnect() {
      for (const listener of channelDisconnectListeners) listener();
    },
    removedChannelMessageListeners() {
      return removedChannelMessageListeners;
    },
    rawChannelDisconnects() {
      return rawChannelDisconnects;
    },
    sentChannelMessages() {
      return [...sentChannel];
    },
  };
}

describe('Chrome extension runtime adapter contract', () => {
  runRuntimeAdapterContract(createChromeDriver);

  it('fails startup when a required event cannot be cancelled', () => {
    expect(() => createChromeContentCapabilities({
      runtime: {
        sendMessage: () => undefined,
        onMessage: {
          addListener: () => undefined,
        },
      },
    })).toThrow(ExtensionContractError);
    expect(() => createChromeContentCapabilities({
      runtime: {
        sendMessage: () => undefined,
        onMessage: {
          addListener: () => undefined,
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'context-unavailable',
      retryable: false,
    }));
  });
});
