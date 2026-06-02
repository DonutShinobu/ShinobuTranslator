import { canvasToBlob } from './utils';

export type ScreenshotRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ScreenshotSelection = {
  viewportRect: ScreenshotRect;
  documentRect: ScreenshotRect;
};

export type ScreenshotCropRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

type Size = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeScreenshotRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  viewportWidth: number,
  viewportHeight: number,
): ScreenshotRect {
  const x1 = clamp(startX, 0, viewportWidth);
  const y1 = clamp(startY, 0, viewportHeight);
  const x2 = clamp(endX, 0, viewportWidth);
  const y2 = clamp(endY, 0, viewportHeight);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left,
    top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function toDocumentScreenshotRect(rect: ScreenshotRect, scrollX: number, scrollY: number): ScreenshotRect {
  return {
    left: rect.left + scrollX,
    top: rect.top + scrollY,
    width: rect.width,
    height: rect.height,
  };
}

export function toScreenshotCropRect(
  viewportRect: ScreenshotRect,
  viewportSize: Size,
  screenshotSize: Size,
): ScreenshotCropRect {
  const scaleX = screenshotSize.width / Math.max(1, viewportSize.width);
  const scaleY = screenshotSize.height / Math.max(1, viewportSize.height);
  const sx = clamp(Math.round(viewportRect.left * scaleX), 0, screenshotSize.width);
  const sy = clamp(Math.round(viewportRect.top * scaleY), 0, screenshotSize.height);
  const right = clamp(Math.round((viewportRect.left + viewportRect.width) * scaleX), sx, screenshotSize.width);
  const bottom = clamp(Math.round((viewportRect.top + viewportRect.height) * scaleY), sy, screenshotSize.height);
  return {
    sx,
    sy,
    sw: Math.max(1, right - sx),
    sh: Math.max(1, bottom - sy),
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('加载截图失败'));
    image.src = dataUrl;
  });
}

export async function cropScreenshotToFile(
  dataUrl: string,
  viewportRect: ScreenshotRect,
  viewportSize: Size,
): Promise<File> {
  const image = await loadImage(dataUrl);
  const crop = toScreenshotCropRect(
    viewportRect,
    viewportSize,
    { width: image.naturalWidth, height: image.naturalHeight },
  );
  const canvas = document.createElement('canvas');
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建截图画布');
  }
  ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  const blob = await canvasToBlob(canvas);
  return new File([blob], 'screenshot.png', { type: 'image/png' });
}

