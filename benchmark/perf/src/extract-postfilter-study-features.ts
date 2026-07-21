import { createCanvas, loadImage } from "canvas";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_RESULTS = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-postfilter-study-v1-20260721",
);
const DEFAULT_REVIEWED = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
  "reviewed-priority-candidates.json",
);
const DEFAULT_OUTPUT = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-postfilter-study-analysis-v1-20260721",
);
const MAX_MASK_SAMPLE_SIDE = 320;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type Region = {
  id: string;
  box: Rect;
  quad?: [Point, Point, Point, Point];
  direction?: "h" | "v";
  prob?: number;
  originalLineCount?: number;
  sourceText: string;
  bubbleBox?: Rect;
};

type OcrVariant = {
  name: string;
  scale: number;
  variantRegionId: string;
  box: Rect;
  quad: [Point, Point, Point, Point];
  text: string;
  confidence: number;
  accepted: boolean;
};

type OcrVariantRegion = {
  regionId: string;
  sourceText: string;
  probability?: number;
  box: Rect;
  quad?: [Point, Point, Point, Point];
  direction?: "h" | "v";
  variants: OcrVariant[];
};

type BatchRecord = {
  input: string;
  imageWidth: number;
  imageHeight: number;
  stageRegions: {
    ordered: Region[];
  };
  rawMask?: {
    width: number;
    height: number;
    path: string;
  };
  ocrVariantRegions?: OcrVariantRegion[];
};

type ReviewLabel =
  | "face_expression"
  | "broad_character_or_panel"
  | "face_text_mixed"
  | "non_face_art"
  | "actual_text";

type ReviewedCandidate = {
  id: string;
  input: string;
  box: Rect;
  sourceText: string;
  reviewIndex: number;
  reviewLabel: ReviewLabel;
};

type MaskFeatures = {
  sampleWidth: number;
  sampleHeight: number;
  quadSamplePixels: number;
  foregroundPixels: number;
  maskFillRatioInQuad: number;
  maskFillRatioInBox: number;
  foregroundBoundingBoxCoverage: number;
  foregroundDensityInBoundingBox: number;
  componentCount: number;
  largestComponentRatio: number;
  componentAreaCv: number;
  axisResidual: number;
  horizontalProjectionPeakCount: number;
  verticalProjectionPeakCount: number;
  boundaryPixelRatio: number;
  centerFillRatio: number;
  outerFillRatio: number;
  centerVsOuterRatio: number;
  touchesTop: boolean;
  touchesRight: boolean;
  touchesBottom: boolean;
  touchesLeft: boolean;
};

type OcrStabilityFeatures = {
  normalizedTexts: string[];
  acceptedCount: number;
  nonEmptyCount: number;
  distinctNonEmptyCount: number;
  maximumAgreementCount: number;
  stableExact: boolean;
  majorityAgreement: boolean;
  emptyVariantCount: number;
  confidenceMinimum: number;
  confidenceMaximum: number;
  confidenceMean: number;
  confidenceRange: number;
  graphemeCountMinimum: number;
  graphemeCountMaximum: number;
  graphemeCountRange: number;
  maximumNormalizedEditDistance: number;
  originalVariantMatchesPipeline: boolean;
};

type FeatureRow = {
  id: string;
  input: string;
  imageWidth: number;
  imageHeight: number;
  regionId: string;
  sourceText: string;
  normalizedSourceText: string;
  graphemeCount: number;
  probability: number;
  box: Rect;
  quad?: [Point, Point, Point, Point];
  direction?: "h" | "v";
  originalLineCount: number;
  hasBubble: boolean;
  relativeArea: number;
  widthRatio: number;
  heightRatio: number;
  aspectRatio: number;
  cheapGate: boolean;
  variants: OcrVariant[];
  ocr: OcrStabilityFeatures;
  mask: MaskFeatures;
};

type ReviewCrosswalk = ReviewedCandidate & {
  matchedFeatureId?: string;
  matchedRegionId?: string;
  matchedSourceText?: string;
  matchIou: number;
  matchIntersectionOverReview: number;
  matchIntersectionOverFeature: number;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").trim();
}

function graphemeCount(text: string): number {
  return Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
  ).length;
}

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function overlapMetrics(a: Rect, b: Rect): {
  iou: number;
  intersectionOverA: number;
  intersectionOverB: number;
} {
  const intersection = intersectionArea(a, b);
  const areaA = Math.max(1, area(a));
  const areaB = Math.max(1, area(b));
  return {
    iou: intersection / Math.max(1, areaA + areaB - intersection),
    intersectionOverA: intersection / areaA,
    intersectionOverB: intersection / areaB,
  };
}

function regionQuad(region: Pick<Region, "box" | "quad">): [Point, Point, Point, Point] {
  return region.quad ?? [
    { x: region.box.x, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
    { x: region.box.x, y: region.box.y + region.box.height },
  ];
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (
      (a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-12) + a.x
    );
    if (crosses) inside = !inside;
  }
  return inside;
}

function countProjectionPeaks(values: number[]): number {
  if (values.length === 0) return 0;
  const maximum = Math.max(...values);
  if (maximum <= 0) return 0;
  const threshold = maximum * 0.2;
  let peaks = 0;
  let active = false;
  for (const value of values) {
    if (value >= threshold && !active) {
      peaks += 1;
      active = true;
    } else if (value < threshold * 0.5) {
      active = false;
    }
  }
  return peaks;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length;
  return Math.sqrt(variance) / mean;
}

function connectedComponentAreas(
  binary: Uint8Array,
  width: number,
  height: number,
): number[] {
  const visited = new Uint8Array(binary.length);
  const queue = new Int32Array(binary.length);
  const areas: number[] = [];
  for (let start = 0; start < binary.length; start += 1) {
    if (binary[start] === 0 || visited[start] === 1) continue;
    let head = 0;
    let tail = 0;
    let componentArea = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      componentArea += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (binary[next] === 0 || visited[next] === 1) continue;
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }
    if (componentArea >= 2) areas.push(componentArea);
  }
  return areas;
}

function axisResidual(binary: Uint8Array, width: number): number {
  let count = 0;
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < binary.length; index += 1) {
    if (binary[index] === 0) continue;
    count += 1;
    meanX += index % width;
    meanY += Math.floor(index / width);
  }
  if (count < 2) return 0;
  meanX /= count;
  meanY /= count;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let index = 0; index < binary.length; index += 1) {
    if (binary[index] === 0) continue;
    const dx = index % width - meanX;
    const dy = Math.floor(index / width) - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= count;
  yy /= count;
  xy /= count;
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const major = (trace + discriminant) / 2;
  const minor = (trace - discriminant) / 2;
  return major + minor > 0 ? minor / (major + minor) : 0;
}

function maskFeatures(
  maskImage: Awaited<ReturnType<typeof loadImage>>,
  region: OcrVariantRegion,
): MaskFeatures {
  const box = {
    x: Math.max(0, Math.floor(region.box.x)),
    y: Math.max(0, Math.floor(region.box.y)),
    width: Math.max(1, Math.min(
      maskImage.width - Math.max(0, Math.floor(region.box.x)),
      Math.ceil(region.box.width),
    )),
    height: Math.max(1, Math.min(
      maskImage.height - Math.max(0, Math.floor(region.box.y)),
      Math.ceil(region.box.height),
    )),
  };
  const sampleScale = Math.min(
    1,
    MAX_MASK_SAMPLE_SIDE / Math.max(box.width, box.height),
  );
  const sampleWidth = Math.max(1, Math.round(box.width * sampleScale));
  const sampleHeight = Math.max(1, Math.round(box.height * sampleScale));
  const canvas = createCanvas(sampleWidth, sampleHeight);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.drawImage(
    maskImage,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    sampleWidth,
    sampleHeight,
  );
  const rgba = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const quad = regionQuad(region).map((point) => ({
    x: (point.x - box.x) / box.width * sampleWidth,
    y: (point.y - box.y) / box.height * sampleHeight,
  }));
  const binary = new Uint8Array(sampleWidth * sampleHeight);
  const horizontalProjection = new Array<number>(sampleHeight).fill(0);
  const verticalProjection = new Array<number>(sampleWidth).fill(0);
  let foregroundPixels = 0;
  let boxForegroundPixels = 0;
  let quadSamplePixels = 0;
  let boundaryPixels = 0;
  let centerForeground = 0;
  let centerPixels = 0;
  let outerForeground = 0;
  let outerPixels = 0;
  let minForegroundX = sampleWidth;
  let minForegroundY = sampleHeight;
  let maxForegroundX = -1;
  let maxForegroundY = -1;
  const edgeBandX = Math.max(1, Math.round(sampleWidth * 0.03));
  const edgeBandY = Math.max(1, Math.round(sampleHeight * 0.03));
  let touchesTop = false;
  let touchesRight = false;
  let touchesBottom = false;
  let touchesLeft = false;

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = y * sampleWidth + x;
      const foreground = rgba[index * 4] > 127;
      if (foreground) boxForegroundPixels += 1;
      const inside = pointInPolygon(x + 0.5, y + 0.5, quad);
      if (!inside) continue;
      quadSamplePixels += 1;
      const center = (
        x >= sampleWidth * 0.25
        && x < sampleWidth * 0.75
        && y >= sampleHeight * 0.25
        && y < sampleHeight * 0.75
      );
      if (center) centerPixels += 1;
      else outerPixels += 1;
      if (!foreground) continue;
      binary[index] = 1;
      foregroundPixels += 1;
      horizontalProjection[y] += 1;
      verticalProjection[x] += 1;
      if (center) centerForeground += 1;
      else outerForeground += 1;
      minForegroundX = Math.min(minForegroundX, x);
      minForegroundY = Math.min(minForegroundY, y);
      maxForegroundX = Math.max(maxForegroundX, x);
      maxForegroundY = Math.max(maxForegroundY, y);
      touchesLeft ||= x < edgeBandX;
      touchesRight ||= x >= sampleWidth - edgeBandX;
      touchesTop ||= y < edgeBandY;
      touchesBottom ||= y >= sampleHeight - edgeBandY;
    }
  }

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = y * sampleWidth + x;
      if (binary[index] === 0) continue;
      if (
        x === 0
        || y === 0
        || x === sampleWidth - 1
        || y === sampleHeight - 1
        || binary[index - 1] === 0
        || binary[index + 1] === 0
        || binary[index - sampleWidth] === 0
        || binary[index + sampleWidth] === 0
      ) {
        boundaryPixels += 1;
      }
    }
  }

  const componentAreas = connectedComponentAreas(binary, sampleWidth, sampleHeight);
  const foregroundBoundingBoxArea = maxForegroundX >= minForegroundX
    ? (maxForegroundX - minForegroundX + 1) * (maxForegroundY - minForegroundY + 1)
    : 0;
  const centerFillRatio = centerPixels > 0 ? centerForeground / centerPixels : 0;
  const outerFillRatio = outerPixels > 0 ? outerForeground / outerPixels : 0;
  return {
    sampleWidth,
    sampleHeight,
    quadSamplePixels,
    foregroundPixels,
    maskFillRatioInQuad: round(
      foregroundPixels / Math.max(1, quadSamplePixels),
    ),
    maskFillRatioInBox: round(
      boxForegroundPixels / Math.max(1, sampleWidth * sampleHeight),
    ),
    foregroundBoundingBoxCoverage: round(
      foregroundBoundingBoxArea / Math.max(1, sampleWidth * sampleHeight),
    ),
    foregroundDensityInBoundingBox: round(
      foregroundPixels / Math.max(1, foregroundBoundingBoxArea),
    ),
    componentCount: componentAreas.length,
    largestComponentRatio: round(
      (Math.max(0, ...componentAreas)) / Math.max(1, foregroundPixels),
    ),
    componentAreaCv: round(coefficientOfVariation(componentAreas)),
    axisResidual: round(axisResidual(binary, sampleWidth)),
    horizontalProjectionPeakCount: countProjectionPeaks(horizontalProjection),
    verticalProjectionPeakCount: countProjectionPeaks(verticalProjection),
    boundaryPixelRatio: round(boundaryPixels / Math.max(1, foregroundPixels)),
    centerFillRatio: round(centerFillRatio),
    outerFillRatio: round(outerFillRatio),
    centerVsOuterRatio: round(
      centerFillRatio / Math.max(1e-6, outerFillRatio),
    ),
    touchesTop,
    touchesRight,
    touchesBottom,
    touchesLeft,
  };
}

function levenshtein(a: string[], b: string[]): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function normalizedEditDistance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  return levenshtein(left, right) / Math.max(1, left.length, right.length);
}

function ocrStability(
  variants: OcrVariant[],
  pipelineText: string,
): OcrStabilityFeatures {
  const normalizedTexts = variants.map((variant) => normalizeText(variant.text));
  const nonEmpty = normalizedTexts.filter(Boolean);
  const counts = new Map<string, number>();
  for (const text of nonEmpty) counts.set(text, (counts.get(text) ?? 0) + 1);
  const maximumAgreementCount = Math.max(0, ...counts.values());
  const confidences = variants.map((variant) => variant.confidence);
  const lengths = normalizedTexts.map(graphemeCount);
  let maximumNormalizedEditDistance = 0;
  for (let i = 0; i < normalizedTexts.length; i += 1) {
    for (let j = i + 1; j < normalizedTexts.length; j += 1) {
      maximumNormalizedEditDistance = Math.max(
        maximumNormalizedEditDistance,
        normalizedEditDistance(normalizedTexts[i], normalizedTexts[j]),
      );
    }
  }
  const original = variants.find((variant) => variant.name === "original");
  const confidenceMinimum = confidences.length > 0 ? Math.min(...confidences) : 0;
  const confidenceMaximum = confidences.length > 0 ? Math.max(...confidences) : 0;
  const graphemeCountMinimum = lengths.length > 0 ? Math.min(...lengths) : 0;
  const graphemeCountMaximum = lengths.length > 0 ? Math.max(...lengths) : 0;
  return {
    normalizedTexts,
    acceptedCount: variants.filter((variant) => variant.accepted).length,
    nonEmptyCount: nonEmpty.length,
    distinctNonEmptyCount: new Set(nonEmpty).size,
    maximumAgreementCount,
    stableExact: (
      variants.length > 0
      && nonEmpty.length === variants.length
      && maximumAgreementCount === variants.length
    ),
    majorityAgreement: maximumAgreementCount >= 2,
    emptyVariantCount: variants.length - nonEmpty.length,
    confidenceMinimum: round(confidenceMinimum),
    confidenceMaximum: round(confidenceMaximum),
    confidenceMean: round(
      confidences.reduce((sum, value) => sum + value, 0)
      / Math.max(1, confidences.length),
    ),
    confidenceRange: round(
      confidenceMaximum - confidenceMinimum,
    ),
    graphemeCountMinimum,
    graphemeCountMaximum,
    graphemeCountRange: graphemeCountMaximum - graphemeCountMinimum,
    maximumNormalizedEditDistance: round(maximumNormalizedEditDistance),
    originalVariantMatchesPipeline: (
      normalizeText(original?.text ?? "") === normalizeText(pipelineText)
    ),
  };
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
    }
  };
  await walk(directory);
  return paths
    .filter((path) => !path.endsWith("batch-summary.json"))
    .sort();
}

function cheapGate(row: Pick<
  FeatureRow,
  | "normalizedSourceText"
  | "hasBubble"
  | "originalLineCount"
  | "graphemeCount"
  | "relativeArea"
  | "aspectRatio"
>): boolean {
  return (
    Boolean(row.normalizedSourceText)
    && !row.hasBubble
    && row.originalLineCount <= 1
    && row.graphemeCount <= 4
    && row.relativeArea >= 0.015
    && row.aspectRatio <= 1.6
  );
}

function distribution<T extends string | number>(
  values: T[],
): Record<string, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

async function main(): Promise<void> {
  const resultsDir = resolve(readOption("results") ?? DEFAULT_RESULTS);
  const reviewedPath = resolve(readOption("reviewed") ?? DEFAULT_REVIEWED);
  const outputDir = resolve(readOption("output") ?? DEFAULT_OUTPUT);
  const resultPaths = await collectJsonFiles(resultsDir);
  const rows: FeatureRow[] = [];

  for (let index = 0; index < resultPaths.length; index += 1) {
    const resultPath = resultPaths[index];
    const record = JSON.parse(await readFile(resultPath, "utf8")) as BatchRecord;
    if (!record.rawMask || !record.ocrVariantRegions) {
      throw new Error(`缺少 mask 或 OCR variants: ${resultPath}`);
    }
    const maskPath = resolve(resultsDir, record.rawMask.path);
    const maskImage = await loadImage(maskPath);
    if (
      maskImage.width !== record.imageWidth
      || maskImage.height !== record.imageHeight
    ) {
      throw new Error(`mask 尺寸不一致: ${record.input}`);
    }
    const orderedById = new Map(
      record.stageRegions.ordered.map((region) => [region.id, region]),
    );
    for (const variantRegion of record.ocrVariantRegions) {
      const ordered = orderedById.get(variantRegion.regionId);
      if (!ordered) {
        throw new Error(`variant 找不到 ordered region: ${record.input}#${variantRegion.regionId}`);
      }
      const normalizedSourceText = normalizeText(ordered.sourceText);
      const width = Math.max(1, ordered.box.width);
      const height = Math.max(1, ordered.box.height);
      const base = {
        id: `${record.input}#${ordered.id}`,
        input: record.input,
        imageWidth: record.imageWidth,
        imageHeight: record.imageHeight,
        regionId: ordered.id,
        sourceText: ordered.sourceText,
        normalizedSourceText,
        graphemeCount: graphemeCount(normalizedSourceText),
        probability: ordered.prob ?? 0,
        box: ordered.box,
        quad: ordered.quad,
        direction: ordered.direction,
        originalLineCount: ordered.originalLineCount ?? 1,
        hasBubble: ordered.bubbleBox !== undefined,
        relativeArea: width * height / Math.max(
          1,
          record.imageWidth * record.imageHeight,
        ),
        widthRatio: width / Math.max(1, record.imageWidth),
        heightRatio: height / Math.max(1, record.imageHeight),
        aspectRatio: Math.max(width / height, height / width),
        variants: variantRegion.variants,
        ocr: ocrStability(variantRegion.variants, ordered.sourceText),
        mask: maskFeatures(maskImage, variantRegion),
      };
      rows.push({
        ...base,
        cheapGate: cheapGate(base),
      });
    }
    if ((index + 1) % 20 === 0 || index + 1 === resultPaths.length) {
      console.log(`[features] ${index + 1}/${resultPaths.length}`);
    }
  }

  const reviewed = JSON.parse(
    await readFile(reviewedPath, "utf8"),
  ) as ReviewedCandidate[];
  const rowsByInput = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const imageRows = rowsByInput.get(row.input);
    if (imageRows) imageRows.push(row);
    else rowsByInput.set(row.input, [row]);
  }
  const crosswalk: ReviewCrosswalk[] = reviewed.map((candidate) => {
    const matches = (rowsByInput.get(candidate.input) ?? [])
      .map((row) => ({
        row,
        metrics: overlapMetrics(candidate.box, row.box),
      }))
      .sort((a, b) => (
        b.metrics.iou - a.metrics.iou
        || b.metrics.intersectionOverA - a.metrics.intersectionOverA
      ));
    const best = matches[0];
    return {
      ...candidate,
      matchedFeatureId: best?.row.id,
      matchedRegionId: best?.row.regionId,
      matchedSourceText: best?.row.sourceText,
      matchIou: round(best?.metrics.iou ?? 0),
      matchIntersectionOverReview: round(best?.metrics.intersectionOverA ?? 0),
      matchIntersectionOverFeature: round(best?.metrics.intersectionOverB ?? 0),
    };
  });

  const matched = crosswalk.filter((item) => item.matchIou >= 0.5);
  const matchedRows = new Map(rows.map((row) => [row.id, row]));
  const reviewedStability = matched.map((item) => ({
    reviewLabel: item.reviewLabel,
    stableExact: matchedRows.get(item.matchedFeatureId!)?.ocr.stableExact ?? false,
    majorityAgreement: matchedRows.get(item.matchedFeatureId!)?.ocr.majorityAgreement ?? false,
    emptyVariantCount: matchedRows.get(item.matchedFeatureId!)?.ocr.emptyVariantCount ?? 0,
  }));
  const reviewIous = crosswalk.map((item) => item.matchIou);
  const summary = {
    createdAt: new Date().toISOString(),
    resultsDir,
    reviewedPath,
    imageCount: new Set(rows.map((row) => row.input)).size,
    regionCount: rows.length,
    cheapGateRegionCount: rows.filter((row) => row.cheapGate).length,
    cheapGateImageCount: new Set(
      rows.filter((row) => row.cheapGate).map((row) => row.input),
    ).size,
    stableExactRegionCount: rows.filter((row) => row.ocr.stableExact).length,
    unstableRegionCount: rows.filter((row) => !row.ocr.stableExact).length,
    reviewedCount: reviewed.length,
    reviewedMatchedAtIouPoint5: matched.length,
    reviewedMatchIou: {
      minimum: round(reviewIous.length > 0 ? Math.min(...reviewIous) : 0),
      mean: round(
        crosswalk.reduce((sum, item) => sum + item.matchIou, 0)
        / Math.max(1, crosswalk.length),
      ),
      maximum: round(reviewIous.length > 0 ? Math.max(...reviewIous) : 0),
    },
    labelCounts: distribution(reviewed.map((item) => item.reviewLabel)),
    reviewedOcrStabilityByLabel: Object.fromEntries(
      [...new Set(reviewedStability.map((item) => item.reviewLabel))].map((label) => {
        const items = reviewedStability.filter((item) => item.reviewLabel === label);
        return [label, {
          count: items.length,
          stableExact: items.filter((item) => item.stableExact).length,
          majorityAgreement: items.filter((item) => item.majorityAgreement).length,
          anyEmptyVariant: items.filter((item) => item.emptyVariantCount > 0).length,
        }];
      }),
    ),
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(outputDir, "postfilter-features.json"),
      JSON.stringify(rows, null, 2),
      "utf8",
    ),
    writeFile(
      join(outputDir, "review-crosswalk.json"),
      JSON.stringify(crosswalk, null, 2),
      "utf8",
    ),
    writeFile(
      join(outputDir, "feature-summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    ),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
