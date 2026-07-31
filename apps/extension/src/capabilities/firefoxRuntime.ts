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
  idempotentCancel,
  isJsonValue,
  isObject,
  operationFailure,
  requireFunction,
} from './adapterInternal';
import {
  isUnavailableFirefoxMessageError,
  type FirefoxMessageSender,
  type FirefoxPort,
  type FirefoxRequestListener,
  type FirefoxRuntime,
} from './firefoxInternal';

function extensionOrigin(runtime: FirefoxRuntime): string | undefined {
  try {
    const url = new URL(runtime.getURL(''));
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function messageSource(
  sender: FirefoxMessageSender,
  runtime: FirefoxRuntime,
): ExtensionMessageSource {
  const url = sender.documentUrl ?? sender.tab?.url;
  const ownOrigin = extensionOrigin(runtime);
  if (
    (sender.origin && sender.origin === ownOrigin)
    || (url && ownOrigin && url.startsWith(`${ownOrigin}/`))
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

export function firefoxRuntimeRequestClient(
  runtime: FirefoxRuntime,
): RuntimeRequestClient {
  requireFunction(runtime.sendMessage, 'runtime-request', 'request');
  return {
    async request(request) {
      assertJsonValue(request, 'runtime-request', 'request');
      let response: unknown;
      try {
        response = await runtime.sendMessage(request);
      } catch (error) {
        if (isUnavailableFirefoxMessageError(error)) {
          return { status: 'unavailable' };
        }
        throw operationFailure('runtime-request', 'request', error);
      }
      if (response === undefined) return { status: 'no-response' };
      assertJsonValue(response, 'runtime-request', 'receiveResponse');
      return {
        status: 'response',
        value: response,
      };
    },
  };
}

export function firefoxRuntimeRequestServer(
  runtime: FirefoxRuntime,
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
      const listener: FirefoxRequestListener = (request, sender) => {
        if (!isJsonValue(request)) return undefined;
        return handler(request, messageSource(sender, runtime))
          .then((response) => {
            if (response === undefined) return undefined;
            assertJsonValue(response, 'runtime-request', 'respond');
            return response;
          })
          .catch(() => undefined);
      };
      runtime.onMessage.addListener(listener);
      return idempotentCancel(() => {
        runtime.onMessage.removeListener(listener);
      });
    },
  };
}

export function firefoxRuntimeRequestTransport(
  runtime: FirefoxRuntime,
): RuntimeRequestTransport {
  return {
    ...firefoxRuntimeRequestClient(runtime),
    ...firefoxRuntimeRequestServer(runtime),
  };
}

function requirePort(value: unknown): FirefoxPort {
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
  return value as FirefoxPort;
}

function firefoxRuntimeChannel(
  rawPort: FirefoxPort,
  runtime: FirefoxRuntime,
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
      ? messageSource(rawPort.sender, runtime)
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

export function firefoxRuntimeChannelClient(
  runtime: FirefoxRuntime,
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
        return firefoxRuntimeChannel(
          requirePort(runtime.connect({ name })),
          runtime,
        );
      } catch (error) {
        throw operationFailure('runtime-channel', 'open', error);
      }
    },
  };
}

export function firefoxRuntimeChannelServer(
  runtime: FirefoxRuntime,
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
      const rawListener = (port: FirefoxPort): void => {
        try {
          listener(firefoxRuntimeChannel(requirePort(port), runtime));
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

export function firefoxExtensionEnvironment(
  runtime: FirefoxRuntime,
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
        throw operationFailure(
          'extension-environment',
          'resourceUrl',
          error,
        );
      }
    },
  };
}
