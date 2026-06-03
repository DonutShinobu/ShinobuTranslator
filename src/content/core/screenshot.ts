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

export type ScreenshotElementCandidateInput<TElement = unknown> = {
  element: TElement;
  rect: ScreenshotRect;
};

export type ScreenshotElementCandidate<TElement = unknown> = {
  element: TElement;
  rect: ScreenshotRect;
  area: number;
  sourceIndex: number;
};

export type ScreenshotElementDepthDirection = 'larger' | 'smaller';
export type ScreenshotResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

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

export function toViewportScreenshotRect(
  rect: ScreenshotRect,
  viewportWidth: number,
  viewportHeight: number,
): ScreenshotRect {
  const left = clamp(rect.left, 0, viewportWidth);
  const top = clamp(rect.top, 0, viewportHeight);
  const right = clamp(rect.left + rect.width, left, viewportWidth);
  const bottom = clamp(rect.top + rect.height, top, viewportHeight);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function getScreenshotRectArea(rect: ScreenshotRect): number {
  return rect.width * rect.height;
}

function toScreenshotRectKey(rect: ScreenshotRect): string {
  return [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ].join(':');
}

export function buildScreenshotElementCandidates<TElement>(
  inputs: Array<ScreenshotElementCandidateInput<TElement>>,
  viewportSize: Size,
): Array<ScreenshotElementCandidate<TElement>> {
  const minSize = 12;
  const candidates: Array<ScreenshotElementCandidate<TElement>> = [];
  const seen = new Set<string>();

  inputs.forEach((input, sourceIndex) => {
    const rect = toViewportScreenshotRect(input.rect, viewportSize.width, viewportSize.height);
    if (rect.width < minSize || rect.height < minSize) return;
    const key = toScreenshotRectKey(rect);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      element: input.element,
      rect,
      area: getScreenshotRectArea(rect),
      sourceIndex,
    });
  });

  candidates.sort((a, b) => {
    if (a.area !== b.area) return a.area - b.area;
    return a.sourceIndex - b.sourceIndex;
  });
  return candidates;
}

export function getNextScreenshotElementCandidateIndex(
  currentIndex: number,
  count: number,
  direction: ScreenshotElementDepthDirection,
): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return 0;
  if (direction === 'larger') {
    return Math.min(count - 1, currentIndex + 1);
  }
  return Math.max(0, currentIndex - 1);
}

export function moveScreenshotRect(
  rect: ScreenshotRect,
  deltaX: number,
  deltaY: number,
  viewportSize: Size,
): ScreenshotRect {
  const maxLeft = Math.max(0, viewportSize.width - rect.width);
  const maxTop = Math.max(0, viewportSize.height - rect.height);
  return {
    left: clamp(rect.left + deltaX, 0, maxLeft),
    top: clamp(rect.top + deltaY, 0, maxTop),
    width: rect.width,
    height: rect.height,
  };
}

export function resizeScreenshotRect(
  rect: ScreenshotRect,
  handle: ScreenshotResizeHandle,
  deltaX: number,
  deltaY: number,
  viewportSize: Size,
  minSize = 12,
): ScreenshotRect {
  let left = rect.left;
  let top = rect.top;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;

  if (handle.includes('w')) {
    left = clamp(left + deltaX, 0, right - minSize);
  }
  if (handle.includes('e')) {
    right = clamp(right + deltaX, left + minSize, viewportSize.width);
  }
  if (handle.includes('n')) {
    top = clamp(top + deltaY, 0, bottom - minSize);
  }
  if (handle.includes('s')) {
    bottom = clamp(bottom + deltaY, top + minSize, viewportSize.height);
  }

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

export function scaleScreenshotRectAroundPoint(
  rect: ScreenshotRect,
  point: { left: number; top: number },
  scale: number,
  minSize = 24,
  maxSize = 60000,
): ScreenshotRect {
  const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const minLimit = Math.max(1, minSize);
  const maxLimit = Math.max(minLimit, maxSize);
  let nextWidth = width * normalizedScale;
  let nextHeight = height * normalizedScale;
  const minDimension = Math.min(nextWidth, nextHeight);
  if (minDimension < minLimit) {
    const correction = minLimit / minDimension;
    nextWidth *= correction;
    nextHeight *= correction;
  }
  const maxDimension = Math.max(nextWidth, nextHeight);
  if (maxDimension > maxLimit) {
    const correction = maxLimit / maxDimension;
    nextWidth *= correction;
    nextHeight *= correction;
  }
  const ratioX = clamp((point.left - rect.left) / width, 0, 1);
  const ratioY = clamp((point.top - rect.top) / height, 0, 1);
  return {
    left: point.left - ratioX * nextWidth,
    top: point.top - ratioY * nextHeight,
    width: nextWidth,
    height: nextHeight,
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

