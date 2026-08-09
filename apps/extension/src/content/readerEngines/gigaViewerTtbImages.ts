import { readingLogicalPageMemberLimit } from '../core/types';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function canvasToBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) reject(signal.reason);
      else if (blob) resolve(blob);
      else reject(new Error('无法导出 GigaViewer TTB 逻辑页'));
    }, 'image/png');
  });
}

export async function composeGigaViewerTtbFiles(
  files: readonly File[],
  signal: AbortSignal,
  document: Document = globalThis.document,
): Promise<File> {
  if (files.length < 2 || files.length > readingLogicalPageMemberLimit) {
    throw new Error(`GigaViewer TTB 逻辑页必须包含 2 到 ${readingLogicalPageMemberLimit} 个切片`);
  }
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const file of files) {
      throwIfAborted(signal);
      bitmaps.push(await createImageBitmap(file));
    }
    const width = bitmaps[0].width;
    if (bitmaps.some((bitmap) => bitmap.width !== width)) {
      throw new Error('GigaViewer TTB 切片必须等宽');
    }
    const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D 不可用');
    let y = 0;
    for (const bitmap of bitmaps) {
      context.drawImage(bitmap, 0, y);
      y += bitmap.height;
    }
    const blob = await canvasToBlob(canvas, signal);
    return new File([blob], 'giga-viewer-ttb-logical-page.png', { type: 'image/png' });
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

export async function splitGigaViewerTtbBlob(
  blob: Blob,
  memberHeights: readonly number[],
  signal: AbortSignal,
  document: Document = globalThis.document,
): Promise<Blob[]> {
  if (
    memberHeights.length < 2
    || memberHeights.length > readingLogicalPageMemberLimit
    || memberHeights.some((height) => !Number.isInteger(height) || height <= 0)
  ) {
    throw new Error('GigaViewer TTB 逻辑页裁切高度无效');
  }
  throwIfAborted(signal);
  const bitmap = await createImageBitmap(blob);
  try {
    const expectedHeight = memberHeights.reduce((sum, height) => sum + height, 0);
    if (bitmap.height !== expectedHeight) {
      throw new Error('GigaViewer TTB 逻辑页结果高度与成员切片不一致');
    }
    const results: Blob[] = [];
    let sourceY = 0;
    for (const height of memberHeights) {
      throwIfAborted(signal);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D 不可用');
      context.drawImage(
        bitmap,
        0,
        sourceY,
        bitmap.width,
        height,
        0,
        0,
        bitmap.width,
        height,
      );
      results.push(await canvasToBlob(canvas, signal));
      sourceY += height;
    }
    return results;
  } finally {
    bitmap.close();
  }
}
