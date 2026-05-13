import type { Rect, TextRegion } from "../../types";
import type { MaskRefinementOptions, AssignedExtent, Component } from "./algorithms";
import {
  makeCanvas,
  readBinaryMask,
  readGrayImage,
  drawRectOutline,
  polygonRectIntersectionArea,
  polygonDistanceToPoint,
  connectedComponents,
  computeScaleFactor,
  scaleRegions,
  hasForeground,
  extractSubMask,
  extractSubGray,
  refineRegionMask,
  replaceSubMask,
  dilate,
  orSubMask,
  toMaskCanvas,
  extendRect,
} from "./algorithms";

export type { MaskRefinementOptions } from "./algorithms";

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