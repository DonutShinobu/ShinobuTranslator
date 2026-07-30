import type {
  ExtensionEnvironment,
  ExtensionMessageSource,
  RuntimeChannel,
  RuntimeChannelClient,
  RuntimeChannelServer,
  RuntimeRequestClient,
  RuntimeRequestServer,
  RuntimeRequestTransport,
} from './contracts';
import {
  ExtensionContractError,
  ExtensionOperationError,
} from './errors';
import {
  assertJsonValue,
  chromeCallback,
  idempotentCancel,
  isJsonValue,
  isObject,
  isUnavailableMessageError,
  operationFailure,
  requireFunction,
  type ChromeMessageSender,
  type ChromePort,
  type ChromeRequestListener,
  type ChromeRuntime,
} from './chromeInternal';

function messageSource(
  sender: ChromeMessageSender,
  extensionId: string | undefined,
): ExtensionMessageSource {
  const url = sender.documentUrl ?? sender.tab?.url;
  const extensionOrigin = extensionId
    ? `chrome-extension://${extensionId}`
    : undefined;
  if (
    (sender.origin && sender.origin === extensionOrigin)
    || (url && extensionOrigin && url.startsWith(`${extensionOrigin}/`))
  ) {
    return {
      kind: 'extension-document',
      ...(sender.documentId ? { documentId: sender.documentId } : {}),
      ...(url ? { url } : {}),
    };
  }

  const tabId = sender.tab?.id;
  if (sender.documentId && typeof tabId === 'number') {
    return {
      kind: 'tab-document',
      documentId: sender.documentId,
      tabId,
      ...(typeof sender.tab?.windowId === 'number'
        ? { windowId: sender.tab.windowId }
        : {}),
      frameId: sender.frameId ?? 0,
      ...(url ? { url } : {}),
    };
  }
  return { kind: 'unknown' };
}

export function runtimeRequestClient(
  runtime: ChromeRuntime,
): RuntimeRequestClient {
  requireFunction(runtime.sendMessage, 'runtime-request', 'request');
  return {
    async request(request) {
      assertJsonValue(request, 'runtime-request', 'request');
      const response = await chromeCallback<
        { status: 'received'; value: unknown } | { status: 'unavailable' }
      >(
        runtime,
        'runtime-request',
        'request',
        (complete) => runtime.sendMessage(
          request,
          (value) => complete({ status: 'received', value }),
        ),
        (error) => isUnavailableMessageError(error)
          ? { handled: true, value: { status: 'unavailable' } }
          : { handled: false },
      );
      if (response.status === 'unavailable') return response;
      if (response.value === undefined) return { status: 'no-response' };
      assertJsonValue(response.value, 'runtime-request', 'receiveResponse');
      return {
        status: 'response',
        value: response.value,
      };
    },
  };
}

export function runtimeRequestServer(
  runtime: ChromeRuntime,
): RuntimeRequestServer {
  if (!isObject(runtime.onMessage)) {
    throw new ExtensionContractError({
      capability: 'runtime-request',
      operation: 'onRequest',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'onMessage',
      },
    });
  }
  requireFunction(runtime.onMessage.addListener, 'runtime-request', 'onRequest');
  requireFunction(
    runtime.onMessage.removeListener,
    'runtime-request',
    'cancelRequestListener',
  );
  return {
    onRequest(handler) {
      const listener: ChromeRequestListener = (request, sender, sendResponse) => {
        if (!isJsonValue(request)) {
          sendResponse(undefined);
          return false;
        }
        void handler(request, messageSource(sender, runtime.id))
          .then((response) => {
            if (response === undefined) {
              sendResponse(undefined);
              return;
            }
            assertJsonValue(response, 'runtime-request', 'respond');
            sendResponse(response);
          })
          .catch(() => {
            sendResponse(undefined);
          });
        return true;
      };
      runtime.onMessage.addListener(listener);
      return idempotentCancel(() => {
        runtime.onMessage.removeListener(listener);
      });
    },
  };
}

export function runtimeRequestTransport(
  runtime: ChromeRuntime,
): RuntimeRequestTransport {
  return {
    ...runtimeRequestClient(runtime),
    ...runtimeRequestServer(runtime),
  };
}

function requirePort(value: unknown): ChromePort {
  if (!isObject(value)) {
    throw new ExtensionOperationError({
      capability: 'runtime-channel',
      operation: 'open',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'port',
      },
    });
  }
  requireFunction(value.postMessage, 'runtime-channel', 'send');
  requireFunction(value.disconnect, 'runtime-channel', 'disconnect');
  for (const [eventName, event] of [
    ['onMessage', value.onMessage],
    ['onDisconnect', value.onDisconnect],
  ] as const) {
    if (!isObject(event)) {
      throw new ExtensionOperationError({
        capability: 'runtime-channel',
        operation: 'open',
        code: 'context-unavailable',
        retryable: false,
        diagnostic: {
          missing: eventName,
        },
      });
    }
    requireFunction(event.addListener, 'runtime-channel', `subscribe:${eventName}`);
    requireFunction(event.removeListener, 'runtime-channel', `cancel:${eventName}`);
  }
  return value as ChromePort;
}

function runtimeChannel(
  rawPort: ChromePort,
  extensionId: string | undefined,
): RuntimeChannel {
  let disconnectReason: 'peer-disconnected' | 'closed-locally' | undefined;
  let closingLocally = false;
  const disconnectListeners = new Set<
    (reason: 'peer-disconnected' | 'closed-locally') => void
  >();
  let rawDisconnectListener: () => void;
  const notifyDisconnect = (
    reason: 'peer-disconnected' | 'closed-locally',
  ): void => {
    if (disconnectReason) return;
    disconnectReason = reason;
    rawPort.onDisconnect.removeListener(rawDisconnectListener);
    for (const listener of disconnectListeners) listener(reason);
    disconnectListeners.clear();
  };
  rawDisconnectListener = (): void => {
    notifyDisconnect(closingLocally ? 'closed-locally' : 'peer-disconnected');
  };
  rawPort.onDisconnect.addListener(rawDisconnectListener);

  return {
    name: rawPort.name,
    source: rawPort.sender
      ? messageSource(rawPort.sender, extensionId)
      : { kind: 'unknown' },
    async send(message) {
      assertJsonValue(message, 'runtime-channel', 'send');
      if (disconnectReason) {
        throw new ExtensionOperationError({
          capability: 'runtime-channel',
          operation: 'send',
          code: 'transport-disconnected',
          retryable: false,
          diagnostic: {},
        });
      }
      try {
        rawPort.postMessage(message);
      } catch (error) {
        throw operationFailure('runtime-channel', 'send', error);
      }
    },
    onMessage(listener) {
      const rawListener = (message: unknown): void => {
        if (isJsonValue(message)) listener(message);
      };
      rawPort.onMessage.addListener(rawListener);
      return idempotentCancel(() => {
        rawPort.onMessage.removeListener(rawListener);
      });
    },
    onDisconnect(listener) {
      if (disconnectReason) {
        listener(disconnectReason);
        return () => undefined;
      }
      disconnectListeners.add(listener);
      return idempotentCancel(() => {
        disconnectListeners.delete(listener);
      });
    },
    async disconnect() {
      if (disconnectReason) return;
      closingLocally = true;
      try {
        rawPort.disconnect();
        notifyDisconnect('closed-locally');
      } catch (error) {
        throw operationFailure('runtime-channel', 'disconnect', error);
      } finally {
        closingLocally = false;
      }
    },
  };
}

export function runtimeChannelClient(
  runtime: ChromeRuntime,
): RuntimeChannelClient {
  requireFunction(runtime.connect, 'runtime-channel', 'open');
  return {
    async open(name) {
      if (name.length === 0) {
        throw new ExtensionOperationError({
          capability: 'runtime-channel',
          operation: 'open',
          code: 'serialization-failed',
          retryable: false,
          diagnostic: {
            reason: 'empty-channel-name',
          },
        });
      }
      try {
        return runtimeChannel(requirePort(runtime.connect({ name })), runtime.id);
      } catch (error) {
        throw operationFailure('runtime-channel', 'open', error);
      }
    },
  };
}

export function runtimeChannelServer(
  runtime: ChromeRuntime,
): RuntimeChannelServer {
  if (!isObject(runtime.onConnect)) {
    throw new ExtensionContractError({
      capability: 'runtime-channel',
      operation: 'onChannel',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'runtime.onConnect',
      },
    });
  }
  requireFunction(runtime.onConnect.addListener, 'runtime-channel', 'onChannel');
  requireFunction(
    runtime.onConnect.removeListener,
    'runtime-channel',
    'cancel:onChannel',
  );
  return {
    onChannel(listener) {
      const rawListener = (port: ChromePort): void => {
        try {
          listener(runtimeChannel(requirePort(port), runtime.id));
        } catch {
          // Malformed native ports cannot satisfy the public channel contract.
        }
      };
      runtime.onConnect.addListener(rawListener);
      return idempotentCancel(() => {
        runtime.onConnect.removeListener(rawListener);
      });
    },
  };
}

export function extensionEnvironment(
  runtime: ChromeRuntime,
): ExtensionEnvironment {
  requireFunction(runtime.getManifest, 'extension-environment', 'metadata');
  requireFunction(runtime.getURL, 'extension-environment', 'resourceUrl');
  const version = runtime.getManifest().version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new ExtensionContractError({
      capability: 'extension-environment',
      operation: 'metadata',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'version',
      },
    });
  }
  return {
    metadata: Object.freeze({ version }),
    resourceUrl(path) {
      try {
        return runtime.getURL(path);
      } catch (error) {
        throw operationFailure('extension-environment', 'resourceUrl', error);
      }
    },
  };
}
