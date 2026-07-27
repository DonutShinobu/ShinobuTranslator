import { getChromeApi } from "../../shared/chrome";
import type { ChromeMessageSender } from "../../shared/chrome";

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
