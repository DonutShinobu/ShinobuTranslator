import type { Rect, TextRegion } from "../types";

type Panel = Rect;

type ConnectedComponent = {
  rect: Rect;
  area: number;
};

const panelDetectMaxSide = 1800;
const panelThreshold = 200;
const panelKernel = [1, 6, 15, 20, 15, 6, 1];
const panelKernelNorm = 64;
const panelKernelRadius = 3;
const panelBorderSize = 10;
const panelMinAreaRef = 10000;
const panelMaxCount = 80;
const panelCoverageMin = 0.08;
const panelCoverageMax = 4.0;
const defaultRtl = true;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toGrayscale(data: Uint8ClampedArray): Uint8Array {
  const total = data.length / 4;
  const gray = new Uint8Array(total);
  for (let i = 0, p = 0; i < total; i += 1, p += 4) {
    gray[i] = Math.round(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
  }
  return gray;
}

function blurGaussian7(src: Uint8Array, width: number, height: number): Uint8Array {
  const tmp = new Float32Array(width * height);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -panelKernelRadius; k <= panelKernelRadius; k += 1) {
        const sx = clamp(x + k, 0, width - 1);
        sum += src[rowOffset + sx] * panelKernel[k + panelKernelRadius];
      }
      tmp[rowOffset + x] = sum / panelKernelNorm;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -panelKernelRadius; k <= panelKernelRadius; k += 1) {
        const sy = clamp(y + k, 0, height - 1);
        sum += tmp[sy * width + x] * panelKernel[k + panelKernelRadius];
      }
      out[y * width + x] = Math.round(sum / panelKernelNorm);
    }
  }

  return out;
}

function thresholdToBinary(src: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    out[i] = src[i] >= threshold ? 1 : 0;
  }
  return out;
}

function addWhiteBorderAndInvert(src: Uint8Array, width: number, height: number, border: number): {
  mask: Uint8Array;
  width: number;
  height: number;
} {
  const borderedWidth = width + border * 2;
  const borderedHeight = height + border * 2;
  const out = new Uint8Array(borderedWidth * borderedHeight);
  out.fill(1);

  for (let y = 0; y < height; y += 1) {
    const srcOffset = y * width;
    const dstOffset = (y + border) * borderedWidth + border;
    for (let x = 0; x < width; x += 1) {
      out[dstOffset + x] = src[srcOffset + x];
    }
  }

  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i] === 1 ? 0 : 1;
  }

  return { mask: out, width: borderedWidth, height: borderedHeight };
}

function connectedComponents(mask: Uint8Array, width: number, height: number): ConnectedComponent[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components: ConnectedComponent[] = [];

  for (let idx = 0; idx < total; idx += 1) {
    if (mask[idx] === 0 || visited[idx] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = idx;
    tail += 1;
    visited[idx] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      area += 1;

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

    components.push({
      rect: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
      area,
    });
  }

  return components;
}

function mapPanelToOriginal(
  rect: Rect,
  sourceWidth: number,
  sourceHeight: number,
  scaledWidth: number,
  scaledHeight: number,
  scale: number,
  border: number,
): Panel | null {
  const rawX0 = rect.x - border;
  const rawY0 = rect.y - border;
  const rawX1 = rect.x + rect.width - border;
  const rawY1 = rect.y + rect.height - border;
  const x0 = clamp(rawX0, 0, scaledWidth);
  const y0 = clamp(rawY0, 0, scaledHeight);
  const x1 = clamp(rawX1, x0 + 1, scaledWidth);
  const y1 = clamp(rawY1, y0 + 1, scaledHeight);

  const left = clamp(Math.floor(x0 / scale), 0, sourceWidth - 1);
  const top = clamp(Math.floor(y0 / scale), 0, sourceHeight - 1);
  const right = clamp(Math.ceil(x1 / scale), left + 1, sourceWidth);
  const bottom = clamp(Math.ceil(y1 / scale), top + 1, sourceHeight);

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x: left, y: top, width, height };
}

function removeContainedPanels(panels: Panel[]): Panel[] {
  const result: Panel[] = [];
  for (let i = 0; i < panels.length; i += 1) {
    const panel = panels[i];
    let contained = false;
    for (let j = 0; j < panels.length; j += 1) {
      if (i === j) {
        continue;
      }
      const outer = panels[j];
      const within =
        panel.x >= outer.x &&
        panel.y >= outer.y &&
        panel.x + panel.width <= outer.x + outer.width &&
        panel.y + panel.height <= outer.y + outer.height;
      if (within) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      result.push(panel);
    }
  }
  return result;
}

function detectPanels(sourceCanvas: HTMLCanvasElement): Panel[] {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return [];
  }

  const scale = Math.min(1, panelDetectMaxSide / Math.max(sourceWidth, sourceHeight));
  const scaledWidth = Math.max(1, Math.round(sourceWidth * scale));
  const scaledHeight = Math.max(1, Math.round(sourceHeight * scale));

  const work = document.createElement("canvas");
  work.width = scaledWidth;
  work.height = scaledHeight;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return [];
  }
  ctx.drawImage(sourceCanvas, 0, 0, scaledWidth, scaledHeight);
  const imageData = ctx.getImageData(0, 0, scaledWidth, scaledHeight);

  const gray = toGrayscale(imageData.data);
  const blurred = blurGaussian7(gray, scaledWidth, scaledHeight);
  const thresholded = thresholdToBinary(blurred, panelThreshold);
  const { mask, width: borderedWidth, height: borderedHeight } = addWhiteBorderAndInvert(
    thresholded,
    scaledWidth,
    scaledHeight,
    panelBorderSize,
  );

  const minArea = panelMinAreaRef * scale * scale;
  const components = connectedComponents(mask, borderedWidth, borderedHeight);
  const panels: Panel[] = [];
  for (const component of components) {
    if (component.area < minArea) {
      continue;
    }
    const panel = mapPanelToOriginal(
      component.rect,
      sourceWidth,
      sourceHeight,
      scaledWidth,
      scaledHeight,
      scale,
      panelBorderSize,
    );
    if (!panel) {
      continue;
    }
    panels.push(panel);
  }

  const filtered = removeContainedPanels(panels);
  if (filtered.length === 0 || filtered.length > panelMaxCount) {
    return [];
  }

  const imageArea = sourceWidth * sourceHeight;
  const coveredArea = filtered.reduce((sum, panel) => sum + panel.width * panel.height, 0);
  const coverage = coveredArea / Math.max(1, imageArea);
  if (coverage < panelCoverageMin || coverage > panelCoverageMax) {
    return [];
  }

  return filtered;
}

function sortPanelsFill(panels: Panel[], rtl: boolean): Panel[] {
  if (panels.length === 0) {
    return [];
  }

  const remaining = [...panels].sort((a, b) => a.y - b.y);
  const avgH = remaining.reduce((sum, panel) => sum + panel.height, 0) / remaining.length;
  const yThreshold = Math.max(10, avgH * 0.3);
  const ordered: Panel[] = [];

  while (remaining.length > 0) {
    const baseY = remaining[0].y;
    const row: Panel[] = [];
    for (let i = 0; i < remaining.length;) {
      if (Math.abs(remaining[i].y - baseY) <= yThreshold) {
        row.push(remaining[i]);
        remaining.splice(i, 1);
      } else {
        i += 1;
      }
    }
    row.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
    ordered.push(...row);
  }

  return ordered;
}

function regionCenter(region: TextRegion): { x: number; y: number } {
  return {
    x: region.box.x + region.box.width / 2,
    y: region.box.y + region.box.height / 2,
  };
}

function pointInPanel(pointX: number, pointY: number, panel: Panel): boolean {
  return (
    pointX >= panel.x &&
    pointX <= panel.x + panel.width &&
    pointY >= panel.y &&
    pointY <= panel.y + panel.height
  );
}

function distanceSqToPanel(pointX: number, pointY: number, panel: Panel): number {
  const dx = Math.max(panel.x - pointX, 0, pointX - (panel.x + panel.width));
  const dy = Math.max(panel.y - pointY, 0, pointY - (panel.y + panel.height));
  return dx * dx + dy * dy;
}

function assignPanelIndex(regions: TextRegion[], panels: Panel[]): Map<number, TextRegion[]> {
  const grouped = new Map<number, TextRegion[]>();
  for (let i = 0; i < panels.length; i += 1) {
    grouped.set(i, []);
  }

  for (const region of regions) {
    const center = regionCenter(region);
    let assignedIndex = -1;

    for (let i = 0; i < panels.length; i += 1) {
      if (pointInPanel(center.x, center.y, panels[i])) {
        assignedIndex = i;
        break;
      }
    }

    if (assignedIndex < 0) {
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < panels.length; i += 1) {
        const distance = distanceSqToPanel(center.x, center.y, panels[i]);
        if (distance < bestDistance) {
          bestDistance = distance;
          assignedIndex = i;
        }
      }
    }

    if (assignedIndex >= 0) {
      const bucket = grouped.get(assignedIndex);
      if (bucket) {
        bucket.push(region);
      }
    }
  }

  return grouped;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function smartSortWithinGroup(regions: TextRegion[], rtl: boolean): TextRegion[] {
  if (regions.length <= 1) {
    return [...regions];
  }

  const xs = regions.map((region) => regionCenter(region).x);
  const ys = regions.map((region) => regionCenter(region).y);
  const horizontalSpread = std(xs);
  const verticalSpread = std(ys);
  const isHorizontal = horizontalSpread > verticalSpread;

  const sorted: TextRegion[] = [];
  if (isHorizontal) {
    const primary = [...regions].sort((a, b) => {
      const ax = regionCenter(a).x;
      const bx = regionCenter(b).x;
      return rtl ? bx - ax : ax - bx;
    });

    let group: TextRegion[] = [];
    let prevX: number | null = null;
    for (const region of primary) {
      const cx = regionCenter(region).x;
      if (prevX !== null && Math.abs(cx - prevX) > 20) {
        group.sort((a, b) => regionCenter(a).y - regionCenter(b).y);
        sorted.push(...group);
        group = [];
      }
      group.push(region);
      prevX = cx;
    }
    if (group.length > 0) {
      group.sort((a, b) => regionCenter(a).y - regionCenter(b).y);
      sorted.push(...group);
    }
  } else {
    const primary = [...regions].sort((a, b) => regionCenter(a).y - regionCenter(b).y);

    let group: TextRegion[] = [];
    let prevY: number | null = null;
    for (const region of primary) {
      const cy = regionCenter(region).y;
      if (prevY !== null && Math.abs(cy - prevY) > 15) {
        group.sort((a, b) => {
          const ax = regionCenter(a).x;
          const bx = regionCenter(b).x;
          return rtl ? bx - ax : ax - bx;
        });
        sorted.push(...group);
        group = [];
      }
      group.push(region);
      prevY = cy;
    }
    if (group.length > 0) {
      group.sort((a, b) => {
        const ax = regionCenter(a).x;
        const bx = regionCenter(b).x;
        return rtl ? bx - ax : ax - bx;
      });
      sorted.push(...group);
    }
  }

  return sorted;
}

function simpleSort(regions: TextRegion[], rtl: boolean): TextRegion[] {
  const sorted: TextRegion[] = [];
  const byY = [...regions].sort((a, b) => regionCenter(a).y - regionCenter(b).y);

  for (const region of byY) {
    const center = regionCenter(region);
    let inserted = false;

    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      const currentTop = current.box.y;
      const currentBottom = current.box.y + current.box.height;
      const currentCenterX = regionCenter(current).x;

      if (center.y > currentBottom) {
        continue;
      }

      if (center.y < currentTop) {
        sorted.splice(i, 0, region);
        inserted = true;
        break;
      }

      if (rtl && center.x > currentCenterX) {
        sorted.splice(i, 0, region);
        inserted = true;
        break;
      }

      if (!rtl && center.x < currentCenterX) {
        sorted.splice(i, 0, region);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      sorted.push(region);
    }
  }

  return sorted;
}

export function sortRegionsForRender(
  regions: TextRegion[],
  sourceCanvas: HTMLCanvasElement,
): TextRegion[] {
  if (regions.length <= 1) {
    return [...regions];
  }

  const fallback = (): TextRegion[] => simpleSort(regions, defaultRtl);

  try {
    const panels = detectPanels(sourceCanvas);
    if (panels.length === 0) {
      return fallback();
    }

    const sortedPanels = sortPanelsFill(panels, defaultRtl);
    const grouped = assignPanelIndex(regions, sortedPanels);
    const ordered: TextRegion[] = [];

    for (let i = 0; i < sortedPanels.length; i += 1) {
      const group = grouped.get(i) ?? [];
      if (group.length === 0) {
        continue;
      }
      ordered.push(...smartSortWithinGroup(group, defaultRtl));
    }

    if (ordered.length !== regions.length) {
      const seen = new Set(ordered.map((region) => region.id));
      for (const region of regions) {
        if (!seen.has(region.id)) {
          ordered.push(region);
        }
      }
    }

    return ordered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[reading-order] panel-aware 排序失败，回退 simple sort: ${message}`);
    return fallback();
  }
}
