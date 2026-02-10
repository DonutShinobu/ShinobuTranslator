import type { Rect, TextRegion } from "../types";

type Point = {
  x: number;
  y: number;
};

type MaskRefinementMethod = "fit_text";

type MaskRefinementOptions = {
  method?: MaskRefinementMethod;
  dilationOffset?: number;
  kernelSize?: number;
  keepThreshold?: number;
};

type RegionMaskInfo = {
  box: Rect;
  polygon: Point[];
  area: number;
  textSize: number;
};

type Component = {
  pixels: Int32Array;
  rect: Rect;
  area: number;
  center: Point;
};

type AssignedExtent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function readBinaryMask(canvas: HTMLCanvasElement, width: number, height: number): Uint8Array {
  const resized = makeCanvas(width, height);
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Mask refinement 读取遮罩失败：无法创建画布上下文");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = data[p] > 0 ? 1 : 0;
  }
  return out;
}

function readGrayImage(canvas: HTMLCanvasElement, width: number, height: number): Uint8Array {
  const resized = makeCanvas(width, height);
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Mask refinement 读取图像失败：无法创建画布上下文");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
  }
  return out;
}

function drawRectOutline(mask: Uint8Array, width: number, height: number, rect: Rect): void {
  const x0 = clamp(Math.floor(rect.x), 0, width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, height - 1);
  const x1 = clamp(Math.floor(rect.x + rect.width), x0, width - 1);
  const y1 = clamp(Math.floor(rect.y + rect.height), y0, height - 1);

  for (let x = x0; x <= x1; x += 1) {
    mask[y0 * width + x] = 0;
    mask[y1 * width + x] = 0;
  }
  for (let y = y0; y <= y1; y += 1) {
    mask[y * width + x0] = 0;
    mask[y * width + x1] = 0;
  }
}

function polygonArea(points: Point[]): number {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - p.y * q.x;
  }
  return Math.abs(area) * 0.5;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y + 1e-12) + pi.x;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= 1e-12) {
    return Math.hypot(apx, apy);
  }
  const t = clamp((apx * abx + apy * aby) / abLen2, 0, 1);
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

function polygonDistanceToPoint(polygon: Point[], point: Point): number {
  if (polygon.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  if (pointInPolygon(point, polygon)) {
    return 0;
  }
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    minDist = Math.min(minDist, distancePointToSegment(point, a, b));
  }
  return minDist;
}

function clipEdge(
  polygon: Point[],
  inside: (p: Point) => boolean,
  intersect: (a: Point, b: Point) => Point
): Point[] {
  if (polygon.length === 0) {
    return [];
  }
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const prev = polygon[(i + polygon.length - 1) % polygon.length];
    const currentInside = inside(current);
    const prevInside = inside(prev);
    if (currentInside) {
      if (!prevInside) {
        out.push(intersect(prev, current));
      }
      out.push(current);
    } else if (prevInside) {
      out.push(intersect(prev, current));
    }
  }
  return out;
}

function clipPolygonToRect(polygon: Point[], rect: Rect): Point[] {
  const xMin = rect.x;
  const yMin = rect.y;
  const xMax = rect.x + rect.width;
  const yMax = rect.y + rect.height;

  let clipped = [...polygon];
  clipped = clipEdge(
    clipped,
    (p) => p.x >= xMin,
    (a, b) => {
      const t = (xMin - a.x) / (b.x - a.x + 1e-12);
      return { x: xMin, y: a.y + (b.y - a.y) * t };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.x <= xMax,
    (a, b) => {
      const t = (xMax - a.x) / (b.x - a.x + 1e-12);
      return { x: xMax, y: a.y + (b.y - a.y) * t };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.y >= yMin,
    (a, b) => {
      const t = (yMin - a.y) / (b.y - a.y + 1e-12);
      return { x: a.x + (b.x - a.x) * t, y: yMin };
    }
  );
  clipped = clipEdge(
    clipped,
    (p) => p.y <= yMax,
    (a, b) => {
      const t = (yMax - a.y) / (b.y - a.y + 1e-12);
      return { x: a.x + (b.x - a.x) * t, y: yMax };
    }
  );
  return clipped;
}

function polygonRectIntersectionArea(polygon: Point[], rect: Rect): number {
  const clipped = clipPolygonToRect(polygon, rect);
  return polygonArea(clipped);
}

function scaleRegionPolygon(region: TextRegion, scale: number): Point[] {
  if (region.quad && region.quad.length === 4) {
    return region.quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  }
  const x0 = region.box.x * scale;
  const y0 = region.box.y * scale;
  const x1 = (region.box.x + region.box.width) * scale;
  const y1 = (region.box.y + region.box.height) * scale;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
}

function polygonToBox(points: Point[], maxW: number, maxH: number): Rect {
  const minX = clamp(Math.floor(Math.min(...points.map((p) => p.x))), 0, maxW - 1);
  const minY = clamp(Math.floor(Math.min(...points.map((p) => p.y))), 0, maxH - 1);
  const maxX = clamp(Math.ceil(Math.max(...points.map((p) => p.x))), minX + 1, maxW);
  const maxY = clamp(Math.ceil(Math.max(...points.map((p) => p.y))), minY + 1, maxH);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function scaleRegions(regions: TextRegion[], scale: number, maxW: number, maxH: number): RegionMaskInfo[] {
  return regions.map((region) => {
    const scaledPolygon = scaleRegionPolygon(region, scale).map((p) => ({
      x: clamp(p.x, 0, maxW),
      y: clamp(p.y, 0, maxH)
    }));
    const box = polygonToBox(scaledPolygon, maxW, maxH);
    const area = Math.max(1, polygonArea(scaledPolygon));
    const textSize = Math.max(1, Math.min(box.width, box.height));
    return {
      box,
      polygon: scaledPolygon,
      area,
      textSize
    };
  });
}

function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const out: Component[] = [];

  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 0 || visited[i] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = i;
    tail += 1;
    visited[i] = 1;

    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      pixels.push(current);

      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const xStart = Math.max(0, x - 1);
      const xEnd = Math.min(width - 1, x + 1);
      const yStart = Math.max(0, y - 1);
      const yEnd = Math.min(height - 1, y + 1);
      for (let ny = yStart; ny <= yEnd; ny += 1) {
        for (let nx = xStart; nx <= xEnd; nx += 1) {
          if (nx === x && ny === y) {
            continue;
          }
          const next = ny * width + nx;
          if (visited[next] === 1 || mask[next] === 0) {
            continue;
          }
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    const compWidth = maxX - minX + 1;
    const compHeight = maxY - minY + 1;
    const area = pixels.length;
    if (area <= 9 || compWidth <= 0 || compHeight <= 0) {
      continue;
    }

    out.push({
      pixels: Int32Array.from(pixels),
      rect: {
        x: minX,
        y: minY,
        width: compWidth,
        height: compHeight
      },
      area,
      center: {
        x: minX + compWidth * 0.5,
        y: minY + compHeight * 0.5
      }
    });
  }

  return out;
}

function ellipseOffsets(size: number): Array<{ dx: number; dy: number }> {
  const radius = Math.floor(size / 2);
  const out: Array<{ dx: number; dy: number }> = [];
  const r2 = radius * radius + 0.25;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= r2) {
        out.push({ dx, dy });
      }
    }
  }
  return out;
}

function dilate(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
  if (kernelSize <= 1) {
    return mask.slice();
  }
  const out = new Uint8Array(mask.length);
  const offsets = ellipseOffsets(kernelSize);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] === 0) {
        continue;
      }
      for (const { dx, dy } of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

function computeScaleFactor(rawMaskHeight: number, imageHeight: number): number {
  if (rawMaskHeight <= 0 || imageHeight <= 0) {
    return 1;
  }
  return Math.max(Math.min((rawMaskHeight - imageHeight / 3) / rawMaskHeight, 1), 0.5);
}

function toMaskCanvas(mask: Uint8Array, width: number, height: number, outW: number, outH: number): HTMLCanvasElement {
  const src = makeCanvas(width, height);
  const srcCtx = src.getContext("2d");
  if (!srcCtx) {
    throw new Error("Mask refinement 输出失败：无法创建源画布上下文");
  }
  const imageData = srcCtx.createImageData(width, height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const v = mask[i] > 0 ? 255 : 0;
    imageData.data[p] = v;
    imageData.data[p + 1] = v;
    imageData.data[p + 2] = v;
    imageData.data[p + 3] = 255;
  }
  srcCtx.putImageData(imageData, 0, 0);

  const out = makeCanvas(outW, outH);
  const outCtx = out.getContext("2d", { willReadFrequently: true });
  if (!outCtx) {
    throw new Error("Mask refinement 输出失败：无法创建目标画布上下文");
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.drawImage(src, 0, 0, outW, outH);
  const outData = outCtx.getImageData(0, 0, outW, outH);
  for (let p = 0; p < outData.data.length; p += 4) {
    const v = outData.data[p] > 127 ? 255 : 0;
    outData.data[p] = v;
    outData.data[p + 1] = v;
    outData.data[p + 2] = v;
    outData.data[p + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

function hasForeground(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0) {
      return true;
    }
  }
  return false;
}

function extractSubMask(mask: Uint8Array, width: number, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const srcRow = (rect.y + y) * width + rect.x;
    const dstRow = y * rect.width;
    out.set(mask.subarray(srcRow, srcRow + rect.width), dstRow);
  }
  return out;
}

function replaceSubMask(mask: Uint8Array, width: number, rect: Rect, sub: Uint8Array): void {
  for (let y = 0; y < rect.height; y += 1) {
    const dstRow = (rect.y + y) * width + rect.x;
    const srcRow = y * rect.width;
    mask.set(sub.subarray(srcRow, srcRow + rect.width), dstRow);
  }
}

function orSubMask(mask: Uint8Array, width: number, rect: Rect, sub: Uint8Array): void {
  for (let y = 0; y < rect.height; y += 1) {
    const dstRow = (rect.y + y) * width + rect.x;
    const srcRow = y * rect.width;
    for (let x = 0; x < rect.width; x += 1) {
      if (sub[srcRow + x] > 0) {
        mask[dstRow + x] = 1;
      }
    }
  }
}

function extractSubGray(gray: Uint8Array, width: number, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const srcRow = (rect.y + y) * width + rect.x;
    const dstRow = y * rect.width;
    out.set(gray.subarray(srcRow, srcRow + rect.width), dstRow);
  }
  return out;
}

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    hist[gray[i]] += 1;
  }
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) {
    sumAll += i * hist[i];
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) {
      continue;
    }
    const wF = total - wB;
    if (wF === 0) {
      break;
    }
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

function xorCost(a: Uint8Array, b: Uint8Array): number {
  let cost = 0;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] > 0) !== (b[i] > 0)) {
      cost += 1;
    }
  }
  return cost;
}

function refineRegionMask(gray: Uint8Array, seedMask: Uint8Array): Uint8Array {
  if (!hasForeground(seedMask)) {
    return seedMask.slice();
  }
  const threshold = otsuThreshold(gray);
  const candidate = new Uint8Array(gray.length);
  const inverse = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const isDark = gray[i] <= threshold ? 1 : 0;
    candidate[i] = isDark;
    inverse[i] = isDark === 1 ? 0 : 1;
  }
  const costCandidate = xorCost(candidate, seedMask);
  const costInverse = xorCost(inverse, seedMask);
  const chosen = costCandidate <= costInverse ? candidate : inverse;
  if (!hasForeground(chosen)) {
    return seedMask.slice();
  }
  return chosen;
}

function extendRect(rect: Rect, maxX: number, maxY: number, extendSize: number): Rect {
  const x = Math.max(Math.floor(rect.x - extendSize), 0);
  const y = Math.max(Math.floor(rect.y - extendSize), 0);
  const width = Math.min(Math.floor(rect.width + extendSize * 2), maxX - x - 1);
  const height = Math.min(Math.floor(rect.height + extendSize * 2), maxY - y - 1);
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

export function refineTextMask(
  originalCanvas: HTMLCanvasElement,
  regions: TextRegion[],
  rawMaskCanvas: HTMLCanvasElement,
  options: MaskRefinementOptions = {}
): HTMLCanvasElement {
  const method = options.method ?? "fit_text";
  if (method !== "fit_text") {
    throw new Error(`Mask refinement 不支持的 method: ${method}`);
  }

  const width = originalCanvas.width;
  const height = originalCanvas.height;
  if (width <= 0 || height <= 0 || regions.length === 0) {
    return makeCanvas(width, height);
  }
  if (rawMaskCanvas.width <= 0 || rawMaskCanvas.height <= 0) {
    throw new Error("Mask refinement 缺少检测原始 mask，已禁用文本框遮罩回退");
  }

  const dilationOffset = options.dilationOffset ?? 20;
  const kernelSize = options.kernelSize ?? 3;
  const keepThreshold = options.keepThreshold ?? 1e-2;

  const scaleFactor = computeScaleFactor(rawMaskCanvas.height, height);
  const scaledWidth = Math.max(1, Math.round(width * scaleFactor));
  const scaledHeight = Math.max(1, Math.round(height * scaleFactor));

  const scaledMask = readBinaryMask(rawMaskCanvas, scaledWidth, scaledHeight);
  const scaledGray = readGrayImage(originalCanvas, scaledWidth, scaledHeight);
  const scaledRegions = scaleRegions(regions, scaleFactor, scaledWidth, scaledHeight);

  const ccInput = scaledMask.slice();
  for (const region of scaledRegions) {
    drawRectOutline(ccInput, scaledWidth, scaledHeight, region.box);
  }
  const components = connectedComponents(ccInput, scaledWidth, scaledHeight);

  const assigned: Component[][] = new Array(scaledRegions.length).fill(null).map(() => []);
  const extents: Array<AssignedExtent | null> = new Array(scaledRegions.length).fill(null);
  let valid = false;

  for (const component of components) {
    let bestRatio = -1;
    let bestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestIndex = -1;

    for (let i = 0; i < scaledRegions.length; i += 1) {
      const region = scaledRegions[i];
      const overlap = polygonRectIntersectionArea(region.polygon, component.rect);
      const ratio = overlap / Math.max(1, Math.min(component.area, region.area));
      const distance = polygonDistanceToPoint(region.polygon, component.center);

      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestIndex = i;
      }
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    if (bestIndex < 0) {
      continue;
    }

    const bestRegion = scaledRegions[bestIndex];
    if (component.area >= bestRegion.area) {
      continue;
    }

    let targetIndex = bestIndex;
    if (bestRatio <= keepThreshold) {
      if (nearestIndex < 0) {
        continue;
      }
      const region = scaledRegions[nearestIndex];
      const unit = Math.max(Math.min(region.textSize, component.rect.width, component.rect.height), 10);
      if (nearestDistance >= 0.5 * unit) {
        continue;
      }
      targetIndex = nearestIndex;
    }

    assigned[targetIndex].push(component);
    const rect = component.rect;
    const current = extents[targetIndex];
    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.width;
    const y1 = rect.y + rect.height;
    if (!current) {
      extents[targetIndex] = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
    } else {
      current.minX = Math.min(current.minX, x0);
      current.minY = Math.min(current.minY, y0);
      current.maxX = Math.max(current.maxX, x1);
      current.maxY = Math.max(current.maxY, y1);
    }
    valid = true;
  }

  if (!valid) {
    throw new Error("Mask refinement 未分配到有效连通域，已禁用文本框遮罩回退");
  }

  const finalMask = new Uint8Array(scaledWidth * scaledHeight);

  for (let i = 0; i < scaledRegions.length; i += 1) {
    const regionComponents = assigned[i];
    const extent = extents[i];
    if (!extent || regionComponents.length === 0) {
      continue;
    }

    const baseRect: Rect = {
      x: extent.minX,
      y: extent.minY,
      width: Math.max(1, extent.maxX - extent.minX),
      height: Math.max(1, extent.maxY - extent.minY)
    };
    const regionTextSize = Math.max(1, Math.min(baseRect.width, baseRect.height, scaledRegions[i].textSize));

    const regionMask = new Uint8Array(scaledWidth * scaledHeight);
    for (const component of regionComponents) {
      for (const pixel of component.pixels) {
        regionMask[pixel] = 1;
      }
    }

    const rect1 = extendRect(baseRect, scaledWidth, scaledHeight, Math.floor(regionTextSize * 0.1));
    const ccRegion = extractSubMask(regionMask, scaledWidth, rect1);
    if (!hasForeground(ccRegion)) {
      continue;
    }
    const grayRegion = extractSubGray(scaledGray, scaledWidth, rect1);
    const refined = refineRegionMask(grayRegion, ccRegion);
    replaceSubMask(regionMask, scaledWidth, rect1, refined);

    const dilateSize = Math.max(Math.floor(Math.floor((regionTextSize + dilationOffset) * 0.3) / 2) * 2 + 1, 3);
    const rect2 = extendRect(baseRect, scaledWidth, scaledHeight, Math.ceil(dilateSize / 2));
    const ccRegion2 = extractSubMask(regionMask, scaledWidth, rect2);
    const dilated = dilate(ccRegion2, rect2.width, rect2.height, dilateSize);
    orSubMask(finalMask, scaledWidth, rect2, dilated);
  }

  const finalDilated = dilate(finalMask, scaledWidth, scaledHeight, Math.max(1, kernelSize));
  return toMaskCanvas(finalDilated, scaledWidth, scaledHeight, width, height);
}

