import type { PipelineCanvas } from '../runtime/platform';

const encodedCanvasBase64 = new WeakMap<Blob, string>();

export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

export function blobToBase64(blob: Blob): Promise<string> {
  const encoded = encodedCanvasBase64.get(blob);
  if (encoded !== undefined) return Promise.resolve(encoded);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片数据失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function canvasToPngBlobSync(canvas: PipelineCanvas): Blob {
  const prefix = 'data:image/png;base64,';
  const dataUrl = canvas.toDataURL('image/png');
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('导出译图失败');
  }
  const base64 = dataUrl.slice(prefix.length);
  const blob = base64ToBlob(base64, 'image/png');
  if ((globalThis as typeof globalThis & {
    __shinobuColdStartPixelFastPath?: boolean;
  }).__shinobuColdStartPixelFastPath === true) {
    encodedCanvasBase64.set(blob, base64);
  }
  return blob;
}

export function canvasToPngBlob(canvas: PipelineCanvas): Promise<Blob> {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  if (!canvas.toBlob) {
    return Promise.reject(new Error('当前 Canvas 不支持 PNG 导出'));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob?.((blob) => {
      if (!blob) {
        reject(new Error('导出译图失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
