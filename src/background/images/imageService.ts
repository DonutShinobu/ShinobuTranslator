import { getChromeApi } from "../../shared/chrome";
import type { ChromeMessageSender } from "../../shared/chrome";
import { arrayBufferToBase64, toErrorMessage } from "../../shared/utils";

export const pximgRefererRuleId = 1;

export function buildOriginalCandidates(imageUrl: string): string[] {
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

export function getRefererForUrl(url: string): string | undefined {
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
export async function ensurePximgRefererRule(): Promise<void> {
  const api = getChromeApi()?.declarativeNetRequest;
  if (!api?.updateDynamicRules) return;
  try {
    await api.updateDynamicRules({
      removeRuleIds: [pximgRefererRuleId],
      addRules: [{
        id: pximgRefererRuleId,
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


export async function downloadImage(imageUrl: string): Promise<{
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

export function parseImageDataUrl(dataUrl: string): {
  base64: string;
  contentType: string;
} {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error('截图数据格式无效');
  }
  return {
    contentType: match[1] || 'image/png',
    base64: match[2] || '',
  };
}

export function captureVisibleTab(sender: ChromeMessageSender): Promise<{
  base64: string;
  contentType: string;
  sourceUrl: string;
}> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.captureVisibleTab) {
    return Promise.reject(new Error('当前浏览器不支持标签页截图'));
  }

  const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
  return new Promise((resolve, reject) => {
    chromeApi.tabs?.captureVisibleTab?.(windowId, { format: 'png' }, (dataUrl?: string) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      if (!dataUrl) {
        reject(new Error('截图返回为空'));
        return;
      }
      const parsed = parseImageDataUrl(dataUrl);
      resolve({
        ...parsed,
        sourceUrl: sender.tab?.url ?? '',
      });
    });
  });
}
