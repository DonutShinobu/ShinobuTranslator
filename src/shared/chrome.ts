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

export type ChromeMessageSender = {
  tab?: {
    id?: number;
    windowId?: number;
    url?: string;
  };
};

type ChromeLike = {
  runtime?: {
    getURL?: (path: string) => string;
    sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
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
  declarativeNetRequest?: {
    updateDynamicRules?: (options: {
      removeRuleIds: number[];
      addRules: Array<Record<string, unknown>>;
    }) => Promise<void>;
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
