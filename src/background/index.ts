import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
  normalizeSettings,
  type ExtensionSettings,
} from '../shared/config';
import { getChromeApi } from '../shared/chrome';
import { isRuntimeMessage, type RuntimeMessage, type RuntimeResponse } from '../shared/messages';
import { toErrorMessage } from '../shared/utils';

function storageGet(key: string): Promise<unknown> {
  const chromeApi = getChromeApi();
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

function storageSet(key: string, value: unknown): Promise<void> {
  const chromeApi = getChromeApi();
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

async function getSettings(): Promise<ExtensionSettings> {
  const saved = await storageGet(extensionSettingsStorageKey);
  return normalizeSettings(saved);
}

async function setSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await storageSet(extensionSettingsStorageKey, normalized);
  return normalized;
}

function buildOriginalCandidates(imageUrl: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = new URL(imageUrl);
    if (parsed.hostname === 'pbs.twimg.com' && (parsed.searchParams.has('name') || parsed.searchParams.has('format'))) {
      const withOrig = new URL(parsed.toString());
      withOrig.searchParams.set('name', 'orig');
      urls.push(withOrig.toString());
    }
  } catch {
    // ignore parse error and fallback to original URL
  }
  urls.push(imageUrl);
  return Array.from(new Set(urls));
}

function getRefererForUrl(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'i.pximg.net' || hostname.endsWith('.pximg.net')) {
      return 'https://www.pixiv.net/';
    }
  } catch {
    // ignore
  }
  return undefined;
}

// Use declarativeNetRequest to set Referer for pximg.net requests,
// since service worker fetch() cannot override Referer reliably.
async function ensurePximgRefererRule(): Promise<void> {
  const api = (globalThis as any).chrome?.declarativeNetRequest;
  if (!api) return;
  const RULE_ID = 1;
  try {
    await api.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: 'https://www.pixiv.net/',
          }],
        },
        condition: {
          urlFilter: '||i.pximg.net/',
          resourceTypes: ['xmlhttprequest'],
        },
      }],
    });
  } catch {
    // ignore
  }
}

ensurePximgRefererRule();

async function downloadImage(imageUrl: string): Promise<{
  base64: string;
  contentType: string;
  sourceUrl: string;
}> {
  const candidates = buildOriginalCandidates(imageUrl);
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const headers: Record<string, string> = {};
      const referer = getRefererForUrl(url);
      if (referer) headers['Referer'] = referer;
      const response = await fetch(url, { method: 'GET', cache: 'no-store', headers });
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        errors.push(`${url}: 返回空文件`);
        continue;
      }
      return {
        base64: arrayBufferToBase64(buffer),
        contentType: response.headers.get('content-type') ?? 'image/jpeg',
        sourceUrl: url,
      };
    } catch (error) {
      errors.push(`${url}: ${toErrorMessage(error)}`);
    }
  }
  throw new Error(`下载图片失败: ${errors.join(' | ') || '未知错误'}`);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function handleMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  if (message.type === 'mt:get-settings') {
    const settings = await getSettings();
    return {
      ok: true,
      type: 'mt:get-settings',
      settings,
    };
  }

  if (message.type === 'mt:set-settings') {
    const settings = await setSettings(message.settings);
    return {
      ok: true,
      type: 'mt:set-settings',
      settings,
    };
  }

  if (message.type === 'mt:download-image') {
    const downloaded = await downloadImage(message.imageUrl);
    return {
      ok: true,
      type: 'mt:download-image',
      ...downloaded,
    };
  }

  return {
    ok: false,
    type: 'mt:get-settings',
    error: '不支持的消息类型',
  };
}

function initializeBackground(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }

  chromeApi.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void handleMessage(message)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          type: message.type,
          error: toErrorMessage(error),
        } satisfies RuntimeResponse);
      });
    return true;
  });

  void getSettings()
    .catch(() => defaultExtensionSettings)
    .then((settings) => storageSet(extensionSettingsStorageKey, settings))
    .catch(() => undefined);
}

void initializeBackground();
