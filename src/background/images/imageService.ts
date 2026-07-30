import type {
  VisibleTabCapture,
} from '../../../apps/extension/src/capabilities/contracts';

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

export async function captureVisibleTab(
  visibleTabCapture: VisibleTabCapture,
  context: {
    windowId?: number;
    sourceUrl: string;
  },
): Promise<{
  base64: string;
  contentType: string;
  sourceUrl: string;
}> {
  const result = await visibleTabCapture.capturePng(context.windowId);
  if (result.status === 'unavailable') {
    throw new Error('截图返回为空');
  }
  return {
    ...parseImageDataUrl(result.dataUrl),
    sourceUrl: context.sourceUrl,
  };
}
