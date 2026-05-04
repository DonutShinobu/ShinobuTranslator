import type { TextRegion } from "../types";
import { imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { mergeTextLines } from "./textlineMerge";
import { sortRegionsForRender } from "./readingOrder";
import { drawTypeset } from "./typeset";
import { detectBubbles, matchRegionsToBubbles } from "./bubbleDetect";

type DetectedColumn = {
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  text: string;
  charCount: number;
};

type BakeResultRegion = {
  id: string;
  direction: "v";
  box: { x: number; y: number; width: number; height: number };
  quad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  sourceText: string;
  fontSize?: number;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
  originalLineCount?: number;
  translatedColumns?: string[];
  detectedColumns: DetectedColumn[];
  typesetDebug: {
    fittedFontSize: number;
    columnBoxes: Array<{ x: number; y: number; width: number; height: number }>;
  };
};

type BakeResult = {
  imageWidth: number;
  imageHeight: number;
  regions: BakeResultRegion[];
};

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image from data URL"));
    img.src = dataUrl;
  });
}

function centerInBox(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  );
}

function toDetectedColumn(region: TextRegion): DetectedColumn {
  return {
    centerX: region.box.x + region.box.width / 2,
    topY: region.box.y,
    bottomY: region.box.y + region.box.height,
    width: region.box.width,
    height: region.box.height,
    text: region.sourceText,
    charCount: [...region.sourceText].length,
  };
}

export async function shinobuRender(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = imageToCanvas(image);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image);
  const ocrResult = await runOcr(image, detected.regions);

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas);

  const bubbleResult = await detectBubbles(image);
  if (bubbleResult.bubbles.length > 0) {
    matchRegionsToBubbles(regions, bubbleResult.bubbles);
  }

  for (const r of regions) {
    r.translatedText = r.sourceText;
    r.fgColor = [0, 80, 255];
  }

  const typesetResult = await drawTypeset(canvas, regions, "ja", {
    renderText: true,
  });

  return typesetResult.canvas.toDataURL("image/png");
}

export async function shinobuBake(dataUrl: string): Promise<BakeResult> {
  const image = await loadImage(dataUrl);
  const canvas = imageToCanvas(image);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image);
  const ocrResult = await runOcr(image, detected.regions);

  // Snapshot pre-merge regions for ground truth
  const preMergeRegions = ocrResult.regions.filter((r) => r.direction === "v");

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas);

  const bubbleResultBake = await detectBubbles(image);
  if (bubbleResultBake.bubbles.length > 0) {
    matchRegionsToBubbles(regions, bubbleResultBake.bubbles);
  }

  for (const r of regions) {
    r.translatedText = r.sourceText;
  }

  const typesetResult = await drawTypeset(canvas, regions, "ja", {
    debugMode: true,
    renderText: false,
    collectDebugLog: true,
  });

  const debugRegions = typesetResult.debugLog?.regions ?? [];

  const verticalRegions = regions.filter((r) => r.direction === "v");

  const resultRegions: BakeResultRegion[] = verticalRegions.map((merged) => {
    const detectedColumns = preMergeRegions
      .filter((pre) => centerInBox(pre.box, merged.box))
      .map(toDetectedColumn);

    const debugEntry = debugRegions.find((d) => d.regionId === merged.id);

    return {
      id: merged.id,
      direction: "v" as const,
      box: merged.box,
      quad: merged.quad,
      sourceText: merged.sourceText,
      fontSize: merged.fontSize,
      fgColor: merged.fgColor,
      bgColor: merged.bgColor,
      originalLineCount: merged.originalLineCount,
      translatedColumns: merged.translatedColumns,
      detectedColumns,
      typesetDebug: {
        fittedFontSize: debugEntry?.fittedFontSize ?? 0,
        columnBoxes: debugEntry?.columnBoxes ?? [],
      },
    };
  });

  return {
    imageWidth: w,
    imageHeight: h,
    regions: resultRegions,
  };
}
