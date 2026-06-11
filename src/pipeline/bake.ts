import type { SourceTextLineGeometry, TextRegion } from "../types";
import type { PipelineTypesetDebugLog } from "../types";
import type { PlatformProvider, PipelineImage } from "../runtime/platform";
import { imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { mergeTextLines } from "./textlineMerge";
import { sortRegionsForRender } from "./readingOrder";
import { drawTypeset } from "./typeset";
import { detectBubbles, matchRegionsToBubbles } from "./bubbleDetect";

export type DetectedColumn = {
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  text: string;
  charCount: number;
};

export type BakeResultRegion = {
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

export type BakeResult = {
  imageWidth: number;
  imageHeight: number;
  regions: BakeResultRegion[];
};

export type RenderFixtureRegion = {
  id: string;
  direction: "v" | "h";
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
  sourceLineGeometries?: SourceTextLineGeometry[];
};

export type RenderDebugResult = {
  dataUrl: string;
  debugLog: PipelineTypesetDebugLog | null;
};

function loadImage(dataUrl: string, platform: PlatformProvider): Promise<PipelineImage> {
  return platform.loadImage(dataUrl);
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
  const text = region.sourceText.replace(/\s+/g, "");
  return {
    centerX: region.box.x + region.box.width / 2,
    topY: region.box.y,
    bottomY: region.box.y + region.box.height,
    width: region.box.width,
    height: region.box.height,
    text: region.sourceText,
    charCount: [...text].length,
  };
}

function sourceGeometryToDetectedColumn(line: SourceTextLineGeometry): DetectedColumn {
  const text = line.text.replace(/\s+/g, "");
  return {
    centerX: line.centerX,
    topY: line.box.y,
    bottomY: line.box.y + line.box.height,
    width: line.width,
    height: line.height,
    text: line.text,
    charCount: [...text].length,
  };
}

export async function shinobuRender(dataUrl: string, platform: PlatformProvider): Promise<string> {
  const result = await shinobuRenderDebug(dataUrl, platform);
  return result.dataUrl;
}

export async function shinobuRenderDebug(dataUrl: string, platform: PlatformProvider): Promise<RenderDebugResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image, platform);
  const ocrResult = await runOcr(image, detected.regions, undefined, platform);

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas, platform);

  const bubbleResult = await detectBubbles(image, platform);
  if (bubbleResult.bubbles.length > 0) {
    matchRegionsToBubbles(regions, bubbleResult.bubbles);
  }

  for (const r of regions) {
    r.translatedText = r.sourceText;
    r.fgColor = [0, 80, 255];
  }

  const typesetResult = await drawTypeset(canvas, regions, "ja", {
    renderText: true,
    collectDebugLog: true,
  }, platform);

  return {
    dataUrl: typesetResult.canvas.toDataURL("image/png"),
    debugLog: typesetResult.debugLog,
  };
}

function fixtureRegionToTextRegion(region: RenderFixtureRegion): TextRegion {
  return {
    id: region.id,
    box: region.box,
    quad: region.quad,
    direction: region.direction,
    fontSize: region.fontSize,
    fgColor: [0, 80, 255],
    bgColor: region.bgColor,
    originalLineCount: region.originalLineCount,
    sourceText: region.sourceText,
    translatedText: region.sourceText,
    translatedColumns: region.translatedColumns,
    sourceLineGeometries: region.sourceLineGeometries?.map((line) => ({
      ...line,
      box: { ...line.box },
      quad: line.quad?.map((point) => ({ ...point })) as SourceTextLineGeometry["quad"],
    })),
  };
}

export async function shinobuRenderFixtureDebug(
  dataUrl: string,
  fixtureRegions: RenderFixtureRegion[],
  platform: PlatformProvider,
): Promise<RenderDebugResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const regions = fixtureRegions.map(fixtureRegionToTextRegion);

  const bubbleResult = await detectBubbles(image, platform);
  if (bubbleResult.bubbles.length > 0) {
    matchRegionsToBubbles(regions, bubbleResult.bubbles);
  }

  const typesetResult = await drawTypeset(canvas, regions, "ja", {
    renderText: true,
    collectDebugLog: true,
  }, platform);

  return {
    dataUrl: typesetResult.canvas.toDataURL("image/png"),
    debugLog: typesetResult.debugLog,
  };
}

export async function shinobuBake(dataUrl: string, platform: PlatformProvider): Promise<BakeResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image, platform);
  const ocrResult = await runOcr(image, detected.regions, undefined, platform);

  // Snapshot pre-merge regions for ground truth
  const preMergeRegions = ocrResult.regions.filter((r) => r.direction === "v");

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas, platform);

  const bubbleResultBake = await detectBubbles(image, platform);
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
  }, platform);

  const debugRegions = typesetResult.debugLog?.regions ?? [];

  const verticalRegions = regions.filter((r) => r.direction === "v");

  const resultRegions: BakeResultRegion[] = verticalRegions.map((merged) => {
    const detectedColumns = merged.sourceLineGeometries && merged.sourceLineGeometries.length > 0
      ? merged.sourceLineGeometries.map(sourceGeometryToDetectedColumn)
      : preMergeRegions
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
