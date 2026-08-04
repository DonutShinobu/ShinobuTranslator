import { getExtensionApi } from '../../shared/extensionRuntime';

export function storageGet(key: string): Promise<unknown> {
  const chromeApi = getExtensionApi();
  if (!chromeApi?.storage?.local?.get) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.get?.([key], (items: Record<string, unknown>) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(items[key]);
    });
  });
}

export function storageSet(key: string, value: unknown): Promise<void> {
  const chromeApi = getExtensionApi();
  if (!chromeApi?.storage?.local?.set) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.set?.({ [key]: value }, () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function storageRemove(keys: string | string[]): Promise<void> {
  const chromeApi = getExtensionApi();
  if (!chromeApi?.storage?.local?.remove) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.remove?.(Array.isArray(keys) ? keys : [keys], () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}
