type ChromeLike = {
  runtime?: {
    getURL?: (path: string) => string;
    sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
    onMessage?: {
      addListener: (
        listener: (
          message: unknown,
          sender: unknown,
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
    };
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
