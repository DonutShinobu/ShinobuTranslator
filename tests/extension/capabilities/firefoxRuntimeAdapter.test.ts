import { describe, expect, it } from 'vitest';
import {
  createFirefoxContentCapabilities,
} from '../../../apps/extension/src/capabilities/firefoxAdapter';
import type {
  ExtensionMessageSource,
  JsonValue,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionContractError,
} from '../../../apps/extension/src/capabilities/errors';
import {
  runRuntimeAdapterContract,
  type RuntimeAdapterContractDriver,
} from './runtimeAdapterContract.fixture';

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
) => Promise<unknown> | undefined;

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
      origin: 'moz-extension://extension-id',
      tab: {
        id: 91,
        url: source.url,
      },
    };
  }
  return {};
}

function createFirefoxDriver(): RuntimeAdapterContractDriver {
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
    getManifest: () => ({ version: '0.8.1' }),
    getURL: (path: string) => `moz-extension://extension-id/${path}`,
    async sendMessage(request: unknown): Promise<unknown> {
      sent.push(request);
      if (unavailable) {
        unavailable = false;
        throw new Error(
          'Could not establish connection. Receiving end does not exist.',
        );
      }
      if (rejection) {
        const error = rejection;
        rejection = undefined;
        throw error;
      }
      return response;
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
  const capabilities = createFirefoxContentCapabilities({ runtime });

  return {
    capabilities,
    extensionDocumentUrl(path) {
      return `moz-extension://extension-id/${path}`;
    },
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
      return await listener(request, rawSender(source)) as JsonValue | undefined;
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

describe('Firefox extension runtime adapter contract', () => {
  runRuntimeAdapterContract(createFirefoxDriver);

  it('fails startup when a required event cannot be cancelled', () => {
    const create = () => createFirefoxContentCapabilities({
      runtime: {
        sendMessage: async () => undefined,
        onMessage: {
          addListener: () => undefined,
        },
      },
    });

    expect(create).toThrow(ExtensionContractError);
    expect(create).toThrow(expect.objectContaining({
      code: 'context-unavailable',
      retryable: false,
    }));
  });
});
