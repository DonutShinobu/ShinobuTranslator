import type { QuadPoint, SourceTextLineGeometry, TextDirection, TextRegion } from "../types";
import type { PipelineTypesetDebugLog } from "../types";
import type { PlatformProvider, PipelineImage } from "../runtime/platform";
import type { ModelRuntime } from '@shinobu/model-runtime';
import { imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { detectByTesseract } from './detect/heuristicDetect';
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
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
};

export type BakeResultRegion = {
  id: string;
  direction: TextDirection;
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

export type BakeDirection = "all" | TextDirection;

export type ShinobuBakeOptions = {
  direction?: BakeDirection;
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
    quad: region.quad,
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
    quad: line.quad,
  };
}

export async function shinobuRender(
  dataUrl: string,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
): Promise<string> {
  const result = await shinobuRenderDebug(dataUrl, platform, modelRuntime);
  return result.dataUrl;
}

export async function shinobuRenderDebug(
  dataUrl: string,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
): Promise<RenderDebugResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image, platform, modelRuntime, {
    kind: 'tesseract-then-heuristic',
    detectWithTesseract: detectByTesseract,
  });
  const ocrResult = await runOcr(image, detected.regions, undefined, platform, undefined, modelRuntime);

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas, platform);

  const bubbleResult = await detectBubbles(image, platform, modelRuntime);
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
  modelRuntime: ModelRuntime,
): Promise<RenderDebugResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const regions = fixtureRegions.map(fixtureRegionToTextRegion);

  const bubbleResult = await detectBubbles(image, platform, modelRuntime);
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

function includesBakeDirection(direction: TextDirection, selected: BakeDirection): boolean {
  return selected === "all" || direction === selected;
}

function resolveBakeRegionDirection(region: TextRegion): TextDirection {
  if (region.direction === "h" || region.direction === "v") return region.direction;
  const geometryDirection = region.sourceLineGeometries?.find((line) => (
    line.direction === "h" || line.direction === "v"
  ))?.direction;
  if (geometryDirection) return geometryDirection;
  return region.box.height >= region.box.width ? "v" : "h";
}

export async function shinobuBake(
  dataUrl: string,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  options: ShinobuBakeOptions = {},
): Promise<BakeResult> {
  const image = await loadImage(dataUrl, platform);
  const canvas = imageToCanvas(image, platform);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image, platform, modelRuntime, {
    kind: 'tesseract-then-heuristic',
    detectWithTesseract: detectByTesseract,
  });
  const ocrResult = await runOcr(image, detected.regions, undefined, platform, undefined, modelRuntime);

  const selectedDirection = options.direction ?? "all";

  // Snapshot pre-merge regions for ground truth, preserving the requested directions.
  const preMergeRegions = ocrResult.regions.filter((region) => (
    includesBakeDirection(resolveBakeRegionDirection(region), selectedDirection)
  ));

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas, platform);

  const bubbleResultBake = await detectBubbles(image, platform, modelRuntime);
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

  const selectedRegions = regions.filter((region) => (
    includesBakeDirection(resolveBakeRegionDirection(region), selectedDirection)
  ));

  const resultRegions: BakeResultRegion[] = selectedRegions.map((merged) => {
    const direction = resolveBakeRegionDirection(merged);
    const detectedColumns = merged.sourceLineGeometries && merged.sourceLineGeometries.length > 0
      ? merged.sourceLineGeometries.map(sourceGeometryToDetectedColumn)
      : preMergeRegions
          .filter((pre) => (
            resolveBakeRegionDirection(pre) === direction && centerInBox(pre.box, merged.box)
          ))
          .map(toDetectedColumn);

    const debugEntry = debugRegions.find((d) => d.regionId === merged.id);

    return {
      id: merged.id,
      direction,
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
