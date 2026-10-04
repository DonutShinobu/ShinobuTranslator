import type { Rect, TextRegion, RefineTextMaskResult } from "../../types";
import type { MaskRefinementOptions, AssignedExtent, Component } from "./algorithms";
import type { PlatformProvider, PipelineCanvas } from "../../runtime/platform";
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
  detectOutlineWidth,
} from "./algorithms";

export type { MaskRefinementOptions } from "./algorithms";

export type PreparedTextMaskGray = {
  sourceCanvas: PipelineCanvas;
  scaledWidth: number;
  scaledHeight: number;
  pixels: Uint8Array;
};

export function prepareTextMaskGray(
  sourceCanvas: PipelineCanvas,
  rawMaskHeight: number,
  platform: PlatformProvider,
): PreparedTextMaskGray {
  const scaleFactor = computeScaleFactor(rawMaskHeight, sourceCanvas.height);
  const scaledWidth = Math.max(1, Math.round(sourceCanvas.width * scaleFactor));
  const scaledHeight = Math.max(1, Math.round(sourceCanvas.height * scaleFactor));
  return {
    sourceCanvas, scaledWidth, scaledHeight,
    pixels: readGrayImage(sourceCanvas, scaledWidth, scaledHeight, platform),
  };
}

export class MaskRefinementImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskRefinementImageError';
  }
}

export function refineTextMask(
  originalCanvas: PipelineCanvas,
  regions: TextRegion[],
  rawMaskCanvas: PipelineCanvas,
  platform: PlatformProvider,
  options: MaskRefinementOptions = {},
  collectDebugLayers = false,
  preparedGray?: PreparedTextMaskGray,
  collectRegionOwnership = false,
): RefineTextMaskResult {
  const method = options.method ?? "fit_text";
  if (method !== "fit_text") {
    throw new Error(`Mask refinement 不支持的 method: ${method}`);
  }

  const width = originalCanvas.width;
  const height = originalCanvas.height;
  if (width <= 0 || height <= 0 || regions.length === 0) {
    return { refinedMaskCanvas: makeCanvas(width, height, platform) };
  }
  if (rawMaskCanvas.width <= 0 || rawMaskCanvas.height <= 0) {
    throw new Error("Mask refinement 缺少检测原始 mask，已禁用文本框遮罩回退");
  }

  const kernelSize = options.kernelSize ?? 3;
  const keepThreshold = options.keepThreshold ?? 1e-2;

  const scaleFactor = computeScaleFactor(rawMaskCanvas.height, height);
  const scaledWidth = Math.max(1, Math.round(width * scaleFactor));
  const scaledHeight = Math.max(1, Math.round(height * scaleFactor));

  // One buffered record after successful refinement; no clocks or payload copies
  // unless both the explicit diagnostic flag and benchmark observer are present.
  const diagnostics = globalThis as {
    __shinobuColdStartMaskProfile?: boolean;
    __shinobuColdStartMaskHistogram?: boolean;
    __shinobuColdStartPixelFastPath?: boolean;
    __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
  };
  const observe = diagnostics.__shinobuColdStartMaskProfile === true
    && typeof diagnostics.__shinobuColdStartInitMark === 'function'
    ? diagnostics.__shinobuColdStartInitMark : undefined;
  const timings = observe ? {
    readBinaryMs: 0, readGrayMs: 0, prepareCcMs: 0, ccMs: 0, assignmentMs: 0,
    regionsMs: 0, refineMs: 0, outlineMs: 0, localDilateMs: 0,
    finalDilateMs: 0, toMaskCanvasMs: 0,
  } : undefined;
  const startedAt = observe ? performance.now() : 0;
  let stageStartedAt = startedAt;
  let processedRegionCount = 0;

  const scaledMask = readBinaryMask(rawMaskCanvas, scaledWidth, scaledHeight, platform);
  if (timings) {
    const now = performance.now();
    timings.readBinaryMs = now - stageStartedAt;
    stageStartedAt = now;
  }
  const scaledGray = preparedGray?.sourceCanvas === originalCanvas
    && preparedGray.scaledWidth === scaledWidth && preparedGray.scaledHeight === scaledHeight
    && preparedGray.pixels.length === scaledWidth * scaledHeight
    ? preparedGray.pixels
    : readGrayImage(originalCanvas, scaledWidth, scaledHeight, platform);
  if (timings) {
    const now = performance.now();
    timings.readGrayMs = now - stageStartedAt;
    stageStartedAt = now;
  }
  const scaledRegions = scaleRegions(regions, scaleFactor, scaledWidth, scaledHeight);

  const ccInput = scaledMask.slice();
  for (const region of scaledRegions) {
    drawRectOutline(ccInput, scaledWidth, scaledHeight, region.box);
  }
  if (timings) {
    const now = performance.now();
    timings.prepareCcMs = now - stageStartedAt;
    stageStartedAt = now;
  }
  const components = connectedComponents(ccInput, scaledWidth, scaledHeight);
  if (timings) {
    const now = performance.now();
    timings.ccMs = now - stageStartedAt;
    stageStartedAt = now;
  }

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
    throw new MaskRefinementImageError("Mask refinement 未分配到有效连通域，已禁用文本框遮罩回退");
  }
  if (timings) {
    const now = performance.now();
    timings.assignmentMs = now - stageStartedAt;
    stageStartedAt = now;
  }

  const finalMask = new Uint8Array(scaledWidth * scaledHeight);
  const ownership = collectRegionOwnership ? new Int32Array(scaledWidth * scaledHeight) : undefined;
  const refinedMaskBeforeDilate = collectDebugLayers ? new Uint8Array(scaledWidth * scaledHeight) : null;

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

    let regionStageStartedAt = timings ? performance.now() : 0;
    const rect1 = extendRect(baseRect, scaledWidth, scaledHeight, Math.floor(regionTextSize * 0.1));
    const ccRegion = extractSubMask(regionMask, scaledWidth, rect1);
    if (!hasForeground(ccRegion)) {
      if (timings) timings.refineMs += performance.now() - regionStageStartedAt;
      continue;
    }
    const grayRegion = extractSubGray(scaledGray, scaledWidth, rect1);
    const refined = refineRegionMask(grayRegion, ccRegion);
    replaceSubMask(regionMask, scaledWidth, rect1, refined);

    if (refinedMaskBeforeDilate) {
      orSubMask(refinedMaskBeforeDilate, scaledWidth, rect1, extractSubMask(regionMask, scaledWidth, rect1));
    }
    if (timings) {
      const now = performance.now();
      timings.refineMs += now - regionStageStartedAt;
      regionStageStartedAt = now;
      processedRegionCount += 1;
    }

    const outlineWidth = detectOutlineWidth(scaledGray, regionMask, scaledWidth, scaledHeight, baseRect, regionTextSize);
    if (timings) {
      const now = performance.now();
      timings.outlineMs += now - regionStageStartedAt;
      regionStageStartedAt = now;
    }
    const outlineDilateExtra = outlineWidth > 0 ? outlineWidth * 2 : 0;
    const baseRatio = outlineWidth > 0 ? 0.05 : 0.1;
    const baseDilateSize = Math.max(Math.floor(Math.floor(regionTextSize * baseRatio) / 2) * 2 + 1, 3);
    const dilateSize = Math.max(baseDilateSize + outlineDilateExtra, 3);
    const rect2 = extendRect(baseRect, scaledWidth, scaledHeight, Math.ceil(dilateSize / 2));
    const ccRegion2 = extractSubMask(regionMask, scaledWidth, rect2);
    const dilated = dilate(ccRegion2, rect2.width, rect2.height, dilateSize);
    orSubMask(finalMask, scaledWidth, rect2, dilated);
    if (ownership) {
      const rect3 = extendRect(rect2, scaledWidth, scaledHeight, Math.ceil(Math.max(1, kernelSize) / 2));
      const local = new Uint8Array(rect3.width * rect3.height);
      orSubMask(local, rect3.width, {
        x: rect2.x - rect3.x, y: rect2.y - rect3.y, width: rect2.width, height: rect2.height,
      }, dilated);
      const expanded = dilate(local, rect3.width, rect3.height, Math.max(1, kernelSize));
      for (let y = 0; y < rect3.height; y++) {
        for (let x = 0; x < rect3.width; x++) {
          const pixel = (rect3.y + y) * scaledWidth + rect3.x + x;
          if (expanded[y * rect3.width + x] && !ownership[pixel]) ownership[pixel] = i + 1;
        }
      }
    }
    if (timings) timings.localDilateMs += performance.now() - regionStageStartedAt;
  }

  const perRegionDilatedSnapshot = collectDebugLayers ? finalMask.slice() : null;
  if (timings) {
    const now = performance.now();
    timings.regionsMs = now - stageStartedAt;
    stageStartedAt = now;
  }

  const finalDilated = dilate(finalMask, scaledWidth, scaledHeight, Math.max(1, kernelSize));
  if (timings) {
    const now = performance.now();
    timings.finalDilateMs = now - stageStartedAt;
    stageStartedAt = now;
  }
  const refinedMaskCanvas = toMaskCanvas(finalDilated, scaledWidth, scaledHeight, width, height, platform);
  if (timings) timings.toMaskCanvasMs = performance.now() - stageStartedAt;

  const debugLayers = collectDebugLayers && refinedMaskBeforeDilate && perRegionDilatedSnapshot
    ? {
        refinedMask: refinedMaskBeforeDilate,
        perRegionDilated: perRegionDilatedSnapshot,
        globalDilated: finalDilated,
        scaledWidth,
        scaledHeight,
      }
    : undefined;

  if (observe && timings) {
    try {
      observe({
        phase: 'mask.refinement', startedAt, durationMs: performance.now() - startedAt,
        width, height, scaledWidth, scaledHeight, scaleFactor,
        regionCount: regions.length, componentCount: components.length, processedRegionCount,
        collectDebugLayers, histogram: diagnostics.__shinobuColdStartMaskHistogram === true,
        pixelFastPath: diagnostics.__shinobuColdStartPixelFastPath === true,
        timings,
      });
    } catch {
      // Diagnostic observers never change the mask result or error behavior.
    }
  }

  return {
    refinedMaskCanvas, debugLayers,
    ...(ownership ? { regionOwnership: {
      width: scaledWidth, height: scaledHeight, regionIds: regions.map((region) => region.id), labels: ownership,
    } } : {}),
  };
}
