import {
  ExtensionContractError,
  type ExtensionCapability,
  type ExtensionOperation,
} from './errors';
import {
  isObject,
  operationFailure,
} from './adapterInternal';

export type FirefoxMessageSender = {
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

export type FirefoxRequestListener = (
  request: unknown,
  sender: FirefoxMessageSender,
) => Promise<unknown> | undefined;

export type FirefoxListenerEvent<Listener extends (...args: never[]) => unknown> = {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
};

export type FirefoxRuntime = {
  id?: string;
  lastError?: {
    message?: string;
  };
  sendMessage(request: unknown): Promise<unknown>;
  connect(options: { name: string }): FirefoxPort;
  getManifest(): {
    version?: string;
  };
  getURL(path: string): string;
  onMessage: FirefoxListenerEvent<FirefoxRequestListener>;
  onConnect: FirefoxListenerEvent<(port: FirefoxPort) => void>;
  onInstalled: FirefoxListenerEvent<(details: {
    reason?: string;
    previousVersion?: string;
  }) => void>;
};

export type FirefoxPort = {
  name: string;
  sender?: FirefoxMessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: FirefoxListenerEvent<(message: unknown) => void>;
  onDisconnect: FirefoxListenerEvent<() => void>;
};

export type FirefoxApi = {
  runtime: FirefoxRuntime;
  storage?: {
    local?: FirefoxStorageArea;
    session?: FirefoxStorageArea;
  };
  tabs?: FirefoxTabs;
  commands?: FirefoxCommands;
  menus?: FirefoxMenus;
  permissions?: FirefoxPermissions;
  cookies?: FirefoxCookies;
};

export type FirefoxPermissionDetails = {
  permissions?: string[];
  origins?: string[];
  data_collection?: string[];
};

export type FirefoxPermissions = {
  contains(details: FirefoxPermissionDetails): Promise<boolean>;
  request(details: FirefoxPermissionDetails): Promise<boolean>;
  onAdded: FirefoxListenerEvent<(details: FirefoxPermissionDetails) => void>;
  onRemoved: FirefoxListenerEvent<(details: FirefoxPermissionDetails) => void>;
};

export type FirefoxCookie = {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  expirationDate?: unknown;
};

export type FirefoxCookies = {
  getAll(query: {
    url?: string;
    domain?: string;
    name?: string;
  }): Promise<FirefoxCookie[]>;
};

export type FirefoxStorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type FirefoxTabs = {
  sendMessage(
    tabId: number,
    message: unknown,
    options?: { documentId: string },
  ): Promise<unknown>;
  captureVisibleTab(
    windowId: number | undefined,
    options: { format: 'png' },
  ): Promise<string | undefined>;
  create(details: {
    url?: string;
    active?: boolean;
  }): Promise<{ id?: number }>;
  remove(tabId: number): Promise<void>;
  onUpdated: FirefoxListenerEvent<(
    tabId: number,
    change: { url?: string },
    tab?: unknown,
  ) => void>;
  onRemoved: FirefoxListenerEvent<(tabId: number) => void>;
};

export type FirefoxCommands = {
  getAll(): Promise<Array<{
    name?: string;
    description?: string;
    shortcut?: string;
  }>>;
  openShortcutSettings(): Promise<void>;
  onCommand: FirefoxListenerEvent<(
    command: string,
    tab?: { id?: number },
  ) => void>;
};

export type FirefoxMenus = {
  removeAll(): Promise<void>;
  create(item: {
    id: string;
    title: string;
    contexts: string[];
  }, complete?: () => void): unknown;
  onClicked: FirefoxListenerEvent<(
    info: { menuItemId?: string | number },
    tab?: { id?: number },
  ) => void>;
};

export function firefoxApi(value: unknown): FirefoxApi {
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
  return value as FirefoxApi;
}

export async function firefoxPromise<T>(
  capability: ExtensionCapability,
  operation: ExtensionOperation,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    throw operationFailure(capability, operation, error);
  }
}

export function isUnavailableFirefoxMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /(?:receiving end does not exist|no tab with id|no frame with id|no document with id|frame .* was removed)/iu.test(
    message,
  );
}
