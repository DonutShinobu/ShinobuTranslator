import {
  ExtensionContractError,
  type ExtensionCapability,
  type ExtensionOperation,
} from './errors';
import {
  isObject,
  operationFailure,
} from './adapterInternal';
export {
  assertJsonValue,
  idempotentCancel,
  isJsonValue,
  isObject,
  operationFailure,
  requireFunction,
  requireNamespace,
} from './adapterInternal';

export type ChromeMessageSender = {
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

export type ChromeRequestListener = (
  request: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

export type ChromeRuntime = {
  id?: string;
  lastError?: {
    message?: string;
  };
  sendMessage(
    request: unknown,
    callback: (response: unknown) => void,
  ): void;
  connect(options: { name: string }): ChromePort;
  getManifest(): {
    version?: string;
  };
  getURL(path: string): string;
  onMessage: {
    addListener(listener: ChromeRequestListener): void;
    removeListener(listener: ChromeRequestListener): void;
  };
  onConnect: {
    addListener(listener: (port: ChromePort) => void): void;
    removeListener(listener: (port: ChromePort) => void): void;
  };
  onInstalled: {
    addListener(listener: (details: {
      reason?: string;
      previousVersion?: string;
    }) => void): void;
    removeListener(listener: (details: {
      reason?: string;
      previousVersion?: string;
    }) => void): void;
  };
};

export type ChromeLastError = NonNullable<ChromeRuntime['lastError']>;

export type ChromePort = {
  name: string;
  sender?: ChromeMessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
};

export type ChromeApi = {
  runtime: ChromeRuntime;
  storage?: {
    local?: ChromeStorageArea;
    session?: ChromeStorageArea;
  };
  tabs?: ChromeTabs;
  commands?: ChromeCommands;
  permissions?: ChromePermissions;
  cookies?: ChromeCookies;
  contextMenus?: ChromeContextMenus;
  webRequest?: {
    onHeadersReceived?: ChromeHeadersReceivedEvent;
  };
  declarativeNetRequest?: ChromeDeclarativeNetRequest;
};

export type ChromeStorageArea = {
  get(
    keys: string[],
    callback: (values: Record<string, unknown>) => void,
  ): void;
  set(values: Record<string, unknown>, callback: () => void): void;
  remove(keys: string[], callback: () => void): void;
};

export type ChromeTabs = {
  sendMessage(
    tabId: number,
    message: unknown,
    callback: (response: unknown) => void,
  ): void;
  sendMessage(
    tabId: number,
    message: unknown,
    options: { documentId: string },
    callback: (response: unknown) => void,
  ): void;
  captureVisibleTab(
    windowId: number | undefined,
    options: { format: 'png' },
    callback: (dataUrl?: string) => void,
  ): void;
  create(
    details: {
      url?: string;
      active?: boolean;
    },
    callback: (tab: { id?: number }) => void,
  ): void;
  remove(tabId: number, callback: () => void): void;
  onUpdated: {
    addListener(
      listener: (
        tabId: number,
        change: { url?: string },
        tab?: unknown,
      ) => void,
    ): void;
    removeListener(
      listener: (
        tabId: number,
        change: { url?: string },
        tab?: unknown,
      ) => void,
    ): void;
  };
  onRemoved: {
    addListener(listener: (tabId: number) => void): void;
    removeListener(listener: (tabId: number) => void): void;
  };
};

export type ChromeCommands = {
  getAll(
    callback: (
      commands: Array<{
        name?: string;
        description?: string;
        shortcut?: string;
      }>,
    ) => void,
  ): void;
  onCommand: {
    addListener(
      listener: (command: string, tab?: { id?: number }) => void,
    ): void;
    removeListener(
      listener: (command: string, tab?: { id?: number }) => void,
    ): void;
  };
};

export type ChromePermissionDetails = {
  permissions?: string[];
  origins?: string[];
};

export type ChromePermissions = {
  contains(
    details: ChromePermissionDetails,
    callback: (granted: boolean) => void,
  ): void;
  request(
    details: ChromePermissionDetails,
    callback: (granted: boolean) => void,
  ): void;
  onAdded: {
    addListener(listener: (details: ChromePermissionDetails) => void): void;
    removeListener(listener: (details: ChromePermissionDetails) => void): void;
  };
  onRemoved: {
    addListener(listener: (details: ChromePermissionDetails) => void): void;
    removeListener(listener: (details: ChromePermissionDetails) => void): void;
  };
};

export type ChromeCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

export type ChromeCookies = {
  getAll(
    query: {
      url?: string;
      domain?: string;
      name?: string;
    },
    callback: (cookies: ChromeCookie[]) => void,
  ): void;
};

export type ChromeContextMenus = {
  removeAll(callback: () => void): void;
  create(
    item: {
      id: string;
      title: string;
      contexts: string[];
    },
    callback: () => void,
  ): void;
  onClicked: {
    addListener(
      listener: (
        info: { menuItemId?: string | number },
        tab?: { id?: number },
      ) => void,
    ): void;
    removeListener(
      listener: (
        info: { menuItemId?: string | number },
        tab?: { id?: number },
      ) => void,
    ): void;
  };
};

export type ChromeHeadersReceivedDetails = {
  documentId?: string;
  tabId?: number;
  frameId?: number;
  url?: string;
  responseHeaders?: Array<{
    name: string;
    value?: string;
  }>;
};

export type ChromeHeadersReceivedEvent = {
  addListener(
    listener: (details: ChromeHeadersReceivedDetails) => void,
    filter: {
      urls: string[];
      types: Array<'main_frame' | 'sub_frame'>;
    },
    extraInfo: Array<'responseHeaders' | 'extraHeaders'>,
  ): void;
  removeListener(
    listener: (details: ChromeHeadersReceivedDetails) => void,
  ): void;
};

export type ChromeDeclarativeNetRequest = {
  updateDynamicRules(update: {
    removeRuleIds: number[];
    addRules: Array<Record<string, unknown>>;
  }): Promise<void>;
  updateSessionRules(update: {
    removeRuleIds: number[];
    addRules: Array<Record<string, unknown>>;
  }): Promise<void>;
};

export function chromeApi(value: unknown): ChromeApi {
  if (!isObject(value) || !isObject(value.runtime)) {
    throw new ExtensionContractError({
      capability: 'runtime-request',
      operation: 'initialize',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'runtime',
      },
    });
  }
  return value as ChromeApi;
}

export function chromeCallback<T>(
  runtime: ChromeRuntime,
  capability: ExtensionCapability,
  operation: ExtensionOperation,
  invoke: (complete: (value: T) => void) => void,
  handleLastError?: (
    error: ChromeLastError,
  ) => { handled: true; value: T } | { handled: false },
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      invoke((value) => {
        const lastError = runtime.lastError;
        if (lastError) {
          try {
            const decision = handleLastError?.(lastError);
            if (decision?.handled) {
              resolve(decision.value);
              return;
            }
          } catch (error) {
            reject(operationFailure(capability, operation, error));
            return;
          }
          const cause = new Error('Browser extension API rejected the operation');
          reject(operationFailure(capability, operation, cause));
          return;
        }
        resolve(value);
      });
    } catch (error) {
      reject(operationFailure(capability, operation, error));
    }
  });
}

export function isUnavailableMessageError(error: ChromeLastError): boolean {
  const message = error.message ?? '';
  return /(?:receiving end does not exist|no tab with id|no frame with id|no document with id|frame .* was removed)/iu.test(
    message,
  );
}
