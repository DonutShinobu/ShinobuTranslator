const pipelineStageLabels: Readonly<Record<string, string>> = {
  'runtime-prepare': '运行环境准备',
  load: '图片加载',
  preload: '模型加载',
  detect: '文本检测',
  bubble: '气泡检测',
  ocr: 'OCR 识别',
  merge: '文本行合并',
  ocr_postfilter: 'OCR 后处理',
  order: '文字排序',
  translate: '文本翻译',
  mask_refine: '文本遮罩生成',
  inpaint: '图片去字',
  typeset: '文字排版',
  finalize: '结果生成',
};

function pipelineFailureMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('messageKey' in error)) return undefined;
  const messageKey = (error as { messageKey?: unknown }).messageKey;
  if (typeof messageKey !== 'string') {
    return undefined;
  }
  if (
    messageKey.startsWith('pipeline.cancelled.')
    || messageKey.startsWith('translation.cancelled.')
  ) return '任务已取消';
  if (!messageKey.startsWith('pipeline.failure.')) return undefined;
  if (messageKey === 'pipeline.failure.stage') {
    const stage = 'stage' in error && typeof error.stage === 'string'
      ? error.stage
      : undefined;
    return `${stage ? (pipelineStageLabels[stage] ?? stage) : '图片处理'}失败`;
  }
  const messages: Readonly<Record<string, string>> = {
    'pipeline.failure.imageLoad': '图片加载失败',
    'pipeline.failure.imageDecode': '图片解码失败',
    'pipeline.failure.translationUnavailable': '文本翻译服务暂时不可用',
    'pipeline.failure.resourceRelease': '本地图片处理资源释放失败',
    'pipeline.failure.execution': '本地图片处理失败',
    'pipeline.failure.runtime': '本地图片处理失败',
  };
  return messages[messageKey] ?? '本地图片处理失败';
}

export function toErrorMessage(error: unknown): string {
  const pipelineMessage = pipelineFailureMessage(error);
  if (pipelineMessage) return pipelineMessage;
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function downloadJson(data: unknown, filenamePrefix: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, filenamePrefix, 'json');
}

export function downloadText(text: string, filenamePrefix: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, filenamePrefix, 'log');
}

function downloadBlob(blob: Blob, filenamePrefix: string, extension: string): void {
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenamePrefix}-${timestamp}.${extension}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
