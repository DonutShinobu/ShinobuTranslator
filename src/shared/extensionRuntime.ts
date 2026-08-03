type ExtensionContextMenuContext =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio';

export type ExtensionCommand = {
  name?: string;
  description?: string;
  shortcut?: string;
};

export type ExtensionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

export type ExtensionMessageSender = {
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

export type ExtensionPort = {
  name: string;
  sender?: ExtensionMessageSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (listener: (message: unknown, port: ExtensionPort) => void) => void;
    removeListener?: (listener: (message: unknown, port: ExtensionPort) => void) => void;
  };
  onDisconnect: {
    addListener: (listener: (port: ExtensionPort) => void) => void;
    removeListener?: (listener: (port: ExtensionPort) => void) => void;
  };
};

export type ExtensionDnrRuleUpdate = {
  removeRuleIds: number[];
  addRules: Array<Record<string, unknown>>;
};

export type ExtensionWebRequestHeadersDetails = {
  documentId?: string;
  frameId?: number;
  tabId: number;
  url: string;
  responseHeaders?: Array<{
    name: string;
    value?: string;
  }>;
};

export type ExtensionPermissionRequest = {
  permissions?: string[];
  origins?: string[];
  data_collection?: string[];
};

export type ExtensionBrowserApi = {
  runtime?: {
    id?: string;
    getManifest?: () => { version?: string };
    getURL?: (path: string) => string;
    connect?: (connectInfo?: { name?: string }) => ExtensionPort;
    getContexts?: (filter: {
      contextTypes?: Array<'OFFSCREEN_DOCUMENT' | 'BACKGROUND' | 'TAB' | 'POPUP'>;
      documentUrls?: string[];
    }) => Promise<Array<{
      contextType: string;
      documentId?: string;
      documentUrl?: string;
    }>>;
    sendMessage?: (
      message: unknown,
      callback?: (response: unknown) => void,
    ) => Promise<unknown> | void;
    onConnect?: {
      addListener: (listener: (port: ExtensionPort) => void) => void;
    };
    onMessage?: {
      addListener: (
        listener: (
          message: unknown,
          sender: ExtensionMessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ) => void;
    };
    onInstalled?: {
      addListener: (listener: () => void) => void;
    };
    lastError?: { message?: string };
  };
  offscreen?: {
    createDocument?: (options: {
      url: string;
      reasons: Array<'WORKERS'>;
      justification: string;
    }) => Promise<void>;
    closeDocument?: () => Promise<void>;
  };
  permissions?: {
    contains?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
    request?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
    remove?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
  };
  storage?: {
    local?: {
      get?: (keys: string | string[] | Record<string, unknown>, callback: (items: Record<string, unknown>) => void) => void;
      set?: (items: Record<string, unknown>, callback: () => void) => void;
      remove?: (keys: string | string[], callback: () => void) => void;
    };
    session?: {
      get?: (keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>;
      set?: (items: Record<string, unknown>) => Promise<void>;
    };
  };
  tabs?: {
    sendMessage?: (tabId: number, message: unknown) => Promise<unknown>;
    captureVisibleTab?: (
      windowId: number | undefined,
      options: { format: 'png' | 'jpeg' },
      callback: (dataUrl?: string) => void,
    ) => void;
    create?: (
      createProperties: { url?: string; active?: boolean },
      callback?: (tab: { id?: number }) => void,
    ) => Promise<{ id?: number }> | void;
    remove?: (tabId: number, callback?: () => void) => Promise<void> | void;
    onUpdated?: {
      addListener: (
        listener: (tabId: number, changeInfo: { url?: string }, tab: unknown) => void,
      ) => void;
    };
    onRemoved?: {
      addListener: (listener: (tabId: number, removeInfo: unknown) => void) => void;
    };
  };
  contextMenus?: {
    create?: (
      createProperties: {
        id: string;
        title: string;
        contexts?: ExtensionContextMenuContext[];
      },
      callback?: () => void,
    ) => string | number | void;
    removeAll?: (callback?: () => void) => Promise<void> | void;
    onClicked?: {
      addListener: (
        listener: (
          info: { menuItemId?: string | number },
          tab?: { id?: number },
        ) => void,
      ) => void;
    };
  };
  commands?: {
    getAll?: (callback?: (commands: ExtensionCommand[]) => void) => Promise<ExtensionCommand[]> | void;
    openShortcutSettings?: () => Promise<void>;
    onCommand?: {
      addListener: (listener: (command: string, tab?: { id?: number }) => void) => void;
    };
  };
  declarativeNetRequest?: {
    updateDynamicRules?: (options: ExtensionDnrRuleUpdate) => Promise<void>;
    updateSessionRules?: (options: ExtensionDnrRuleUpdate) => Promise<void>;
  };
  webRequest?: {
    onHeadersReceived?: {
      addListener: (
        listener: (details: ExtensionWebRequestHeadersDetails) => void,
        filter: { urls: string[]; types?: Array<'main_frame' | 'sub_frame'> },
        extraInfoSpec?: Array<'responseHeaders' | 'extraHeaders'>,
      ) => void;
    };
  };
  cookies?: {
    getAll?: (
      details: { url?: string; domain?: string; name?: string },
      callback?: (cookies: ExtensionCookie[]) => void,
    ) => Promise<ExtensionCookie[]> | void;
  };
};

type ExtensionNamespace = typeof globalThis & {
  browser?: ExtensionBrowserApi;
  chrome?: ExtensionBrowserApi;
};

function resolveExtensionApi(): ExtensionBrowserApi | null {
  const scope = globalThis as ExtensionNamespace;
  // Firefox exposes the callback-compatible `chrome` namespace as well. Prefer it
  // so legacy APIs such as storage/cookies use one contract in both targets.
  return scope.chrome ?? scope.browser ?? null;
}

function usesPromiseNamespace(api: ExtensionBrowserApi): boolean {
  return (globalThis as ExtensionNamespace).browser === api;
}

export interface ExtensionRuntime {
  readonly api: ExtensionBrowserApi;
  getURL(path: string): string;
  getVersion(): string;
  keepsBackgroundAliveWithPort(): boolean;
  connect(name: string): ExtensionPort;
  sendMessage<TResponse>(message: unknown): Promise<TResponse>;
  getLastErrorMessage(): string | undefined;
  getCommands(): Promise<ExtensionCommand[]>;
  openShortcutSettings(): Promise<void>;
}

function createExtensionRuntime(api: ExtensionBrowserApi): ExtensionRuntime {
  return {
    api,
    getURL(path) {
      const url = api.runtime?.getURL?.(path);
      if (!url) throw new Error('当前环境不支持扩展资源 URL');
      return url;
    },
    getVersion() {
      return api.runtime?.getManifest?.().version ?? '';
    },
    keepsBackgroundAliveWithPort() {
      return api.runtime?.getURL?.('')?.startsWith('moz-extension://') ?? false;
    },
    connect(name) {
      const port = api.runtime?.connect?.({ name });
      if (!port) throw new Error('当前环境不支持扩展 Port');
      return port;
    },
    sendMessage<TResponse>(message: unknown): Promise<TResponse> {
      const sendMessage = api.runtime?.sendMessage;
      if (!sendMessage) return Promise.reject(new Error('当前环境不支持扩展消息'));
      if (usesPromiseNamespace(api)) {
        return Promise.resolve(sendMessage(message) as Promise<unknown>) as Promise<TResponse>;
      }
      return new Promise<TResponse>((resolve, reject) => {
        sendMessage(message, (response) => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          resolve(response as TResponse);
        });
      });
    },
    getLastErrorMessage() {
      return api.runtime?.lastError?.message;
    },
    getCommands() {
      const getAll = api.commands?.getAll;
      if (!getAll) return Promise.resolve([]);
      if (usesPromiseNamespace(api)) {
        return Promise.resolve(getAll() as Promise<ExtensionCommand[]>);
      }
      return new Promise((resolve, reject) => {
        getAll((commands) => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) reject(new Error(runtimeError));
          else resolve(commands);
        });
      });
    },
    async openShortcutSettings() {
      if (api.commands?.openShortcutSettings) {
        await api.commands.openShortcutSettings();
        return;
      }
      const createTab = api.tabs?.create;
      if (!createTab) throw new Error('当前浏览器不支持打开快捷键设置');
      if (usesPromiseNamespace(api)) {
        await createTab({ url: 'chrome://extensions/shortcuts', active: true });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        createTab({ url: 'chrome://extensions/shortcuts', active: true }, () => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) reject(new Error(runtimeError));
          else resolve();
        });
      });
    },
  };
}

export function getExtensionRuntime(): ExtensionRuntime | null {
  const api = resolveExtensionApi();
  return api ? createExtensionRuntime(api) : null;
}

export function requireExtensionRuntime(): ExtensionRuntime {
  const runtime = getExtensionRuntime();
  if (!runtime) throw new Error('当前环境不支持浏览器扩展 API');
  return runtime;
}

export function getExtensionApi(): ExtensionBrowserApi | null {
  return getExtensionRuntime()?.api ?? null;
}

export function requireExtensionApi(): ExtensionBrowserApi {
  return requireExtensionRuntime().api;
}
