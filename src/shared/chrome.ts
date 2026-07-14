type ChromeContextMenuContext =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio';

type ChromeCommand = {
  name?: string;
  description?: string;
  shortcut?: string;
};

type ChromeCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

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

export type ChromePort = {
  name: string;
  sender?: ChromeMessageSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (listener: (message: unknown, port: ChromePort) => void) => void;
    removeListener?: (listener: (message: unknown, port: ChromePort) => void) => void;
  };
  onDisconnect: {
    addListener: (listener: (port: ChromePort) => void) => void;
    removeListener?: (listener: (port: ChromePort) => void) => void;
  };
};

export type ChromeLike = {
  runtime?: {
    getManifest?: () => {
      version?: string;
    };
    getURL?: (path: string) => string;
    connect?: (connectInfo?: { name?: string }) => ChromePort;
    getContexts?: (filter: {
      contextTypes?: Array<'OFFSCREEN_DOCUMENT' | 'BACKGROUND' | 'TAB' | 'POPUP'>;
      documentUrls?: string[];
    }) => Promise<Array<{
      contextType: string;
      documentId?: string;
      documentUrl?: string;
    }>>;
    sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
    onConnect?: {
      addListener: (listener: (port: ChromePort) => void) => void;
    };
    onMessage?: {
      addListener: (
        listener: (
          message: unknown,
          sender: ChromeMessageSender,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ) => void;
    };
    lastError?: {
      message?: string;
    };
  };
  offscreen?: {
    createDocument?: (options: {
      url: string;
      reasons: Array<'WORKERS'>;
      justification: string;
    }) => Promise<void>;
    closeDocument?: () => Promise<void>;
  };
  storage?: {
    local?: {
      get?: (keys: string | string[] | Record<string, unknown>, callback: (items: Record<string, unknown>) => void) => void;
      set?: (items: Record<string, unknown>, callback: () => void) => void;
      remove?: (keys: string | string[], callback: () => void) => void;
    };
  };
  tabs?: {
    sendMessage?: (tabId: number, message: unknown) => Promise<unknown>;
    captureVisibleTab?: (
      windowId: number | undefined,
      options: {
        format: 'png' | 'jpeg';
      },
      callback: (dataUrl?: string) => void
    ) => void;
    create?: (
      createProperties: {
        url?: string;
        active?: boolean;
      },
      callback?: (tab: { id?: number }) => void
    ) => void;
    remove?: (tabId: number, callback?: () => void) => void;
    onUpdated?: {
      addListener: (
        listener: (
          tabId: number,
          changeInfo: {
            url?: string;
          },
          tab: unknown
        ) => void
      ) => void;
    };
    onRemoved?: {
      addListener: (
        listener: (
          tabId: number,
          removeInfo: unknown
        ) => void
      ) => void;
    };
  };
  contextMenus?: {
    create?: (
      createProperties: {
        id: string;
        title: string;
        contexts?: ChromeContextMenuContext[];
      },
      callback?: () => void
    ) => void;
    removeAll?: (callback?: () => void) => void;
    onClicked?: {
      addListener: (
        listener: (
          info: {
            menuItemId?: string | number;
          },
          tab?: {
            id?: number;
          }
        ) => void
      ) => void;
    };
  };
  commands?: {
    getAll?: (callback: (commands: ChromeCommand[]) => void) => void;
    onCommand?: {
      addListener: (
        listener: (
          command: string,
          tab?: {
            id?: number;
          }
        ) => void
      ) => void;
    };
  };
  declarativeNetRequest?: {
    updateDynamicRules?: (options: {
      removeRuleIds: number[];
      addRules: Array<Record<string, unknown>>;
    }) => Promise<void>;
  };
  cookies?: {
    getAll?: (
      details: {
        url?: string;
        domain?: string;
        name?: string;
      },
      callback: (cookies: ChromeCookie[]) => void
    ) => void;
  };
};

export function getChromeApi(): ChromeLike | null {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome;
  return maybeChrome ?? null;
}

export function requireChromeApi(): ChromeLike {
  const chromeApi = getChromeApi();
  if (!chromeApi) {
    throw new Error('当前环境不支持 Chrome 扩展 API');
  }
  return chromeApi;
}
