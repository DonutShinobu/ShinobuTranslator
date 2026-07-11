import { convexHull, polygonArea, polygonSignedArea } from "../../../src/pipeline/utils";
import { segmentVerticalGraphemes } from "../../../src/pipeline/typeset/verticalOrientation";
import type { QuadPoint } from "../../../src/types";
import { clamp01, mean, meanOr, median, percentile } from "./metric-utils";
import type {
  GroundTruthColumn,
  HorizontalMetricValues,
  HorizontalScoreWeights,
} from "./types";

type MetricGlyph = {
  ch: string;
  lineIndex: number;
  charIndex: number;
  sequenceIndex: number;
  x?: number;
  y?: number;
};

type GlyphMatch = {
  gtIndex: number;
  predIndex: number;
};

export type HorizontalGlyphDiagnostic = {
  matchStatus: "matched" | "gt-unmatched" | "pred-unmatched";
  ch: string;
  gtLineIndex?: number;
  gtCharIndex?: number;
  gtSequenceIndex?: number;
  predLineIndex?: number;
  predCharIndex?: number;
  predSequenceIndex?: number;
  gtX?: number;
  gtY?: number;
  predX?: number;
  predY?: number;
  dxNorm?: number;
  dyNorm?: number;
  distanceNorm?: number;
};

export type HorizontalMetricComputation = {
  metrics?: HorizontalMetricValues;
  skipReason?: "no_horizontal_lines" | "no_horizontal_glyph_pairs";
  glyphDiagnostics: HorizontalGlyphDiagnostic[];
};

function isWhitespace(value: string): boolean {
  return /^\s+$/u.test(value);
}

function columnQuad(column: GroundTruthColumn): QuadPoint[] {
  if (column.quad) return column.quad;
  const left = column.centerX - column.width / 2;
  const right = column.centerX + column.width / 2;
  return [
    { x: left, y: column.topY },
    { x: right, y: column.topY },
    { x: right, y: column.bottomY },
    { x: left, y: column.bottomY },
  ];
}

function pointCross(a: QuadPoint, b: QuadPoint, p: QuadPoint): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function lineIntersection(
  segmentStart: QuadPoint,
  segmentEnd: QuadPoint,
  clipStart: QuadPoint,
  clipEnd: QuadPoint,
): QuadPoint {
  const segmentDx = segmentEnd.x - segmentStart.x;
  const segmentDy = segmentEnd.y - segmentStart.y;
  const clipDx = clipEnd.x - clipStart.x;
  const clipDy = clipEnd.y - clipStart.y;
  const denominator = segmentDx * clipDy - segmentDy * clipDx;
  if (Math.abs(denominator) < 1e-9) return { ...segmentEnd };
  const startDx = clipStart.x - segmentStart.x;
  const startDy = clipStart.y - segmentStart.y;
  const t = (startDx * clipDy - startDy * clipDx) / denominator;
  return {
    x: segmentStart.x + t * segmentDx,
    y: segmentStart.y + t * segmentDy,
  };
}

function ensureCounterClockwise(points: QuadPoint[]): QuadPoint[] {
  return polygonSignedArea(points) >= 0 ? [...points] : [...points].reverse();
}

function clipConvexPolygon(subject: QuadPoint[], clip: QuadPoint[]): QuadPoint[] {
  let output = ensureCounterClockwise(subject);
  const clipPolygon = ensureCounterClockwise(clip);
  for (let edgeIndex = 0; edgeIndex < clipPolygon.length; edgeIndex += 1) {
    const clipStart = clipPolygon[edgeIndex];
    const clipEnd = clipPolygon[(edgeIndex + 1) % clipPolygon.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    let previous = input[input.length - 1];
    for (const current of input) {
      const currentInside = pointCross(clipStart, clipEnd, current) >= -1e-7;
      const previousInside = pointCross(clipStart, clipEnd, previous) >= -1e-7;
      if (currentInside) {
        if (!previousInside) {
          output.push(lineIntersection(previous, current, clipStart, clipEnd));
        }
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      previous = current;
    }
  }
  return output;
}

export function convexPolygonIoU(a: QuadPoint[], b: QuadPoint[]): number {
  const hullA = convexHull(a);
  const hullB = convexHull(b);
  const areaA = polygonArea(hullA);
  const areaB = polygonArea(hullB);
  if (areaA <= 0 || areaB <= 0) return 0;
  const intersection = polygonArea(clipConvexPolygon(hullA, hullB));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function quadCenter(points: QuadPoint[]): QuadPoint {
  return {
    x: mean(points.map((point) => point.x)),
    y: mean(points.map((point) => point.y)),
  };
}

function pointDistance(a: QuadPoint, b: QuadPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function quadDimensions(points: QuadPoint[]): { width: number; height: number } {
  if (points.length !== 4) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  return {
    width: (pointDistance(points[0], points[1]) + pointDistance(points[3], points[2])) / 2,
    height: (pointDistance(points[0], points[3]) + pointDistance(points[1], points[2])) / 2,
  };
}

function quadAngleDeg(points: QuadPoint[]): number {
  if (points.length !== 4) return 0;
  const left = {
    x: (points[0].x + points[3].x) / 2,
    y: (points[0].y + points[3].y) / 2,
  };
  const right = {
    x: (points[1].x + points[2].x) / 2,
    y: (points[1].y + points[2].y) / 2,
  };
  return Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI;
}

function angleDifferenceDeg(a: number, b: number): number {
  let difference = Math.abs(a - b) % 180;
  if (difference > 90) difference = 180 - difference;
  return difference;
}

function flattenGlyphs(columns: GroundTruthColumn[]): MetricGlyph[] {
  const glyphs: MetricGlyph[] = [];
  columns.forEach((column, lineIndex) => {
    const chars = segmentVerticalGraphemes(column.text).filter((char) => !isWhitespace(char));
    chars.forEach((ch, charIndex) => {
      const center = column.charCenters[charIndex];
      glyphs.push({
        ch,
        lineIndex,
        charIndex,
        sequenceIndex: glyphs.length,
        x: center?.x,
        y: center?.y,
      });
    });
  });
  return glyphs;
}

function alignGlyphs(gt: MetricGlyph[], pred: MetricGlyph[]): GlyphMatch[] {
  if (
    gt.length === pred.length
    && gt.every((glyph, index) => glyph.ch === pred[index].ch)
  ) {
    return gt.map((_, index) => ({ gtIndex: index, predIndex: index }));
  }

  const dp = Array.from({ length: gt.length + 1 }, () => (
    new Array<number>(pred.length + 1).fill(0)
  ));
  for (let gtIndex = gt.length - 1; gtIndex >= 0; gtIndex -= 1) {
    for (let predIndex = pred.length - 1; predIndex >= 0; predIndex -= 1) {
      dp[gtIndex][predIndex] = gt[gtIndex].ch === pred[predIndex].ch
        ? 1 + dp[gtIndex + 1][predIndex + 1]
        : Math.max(dp[gtIndex + 1][predIndex], dp[gtIndex][predIndex + 1]);
    }
  }

  const matches: GlyphMatch[] = [];
  let gtIndex = 0;
  let predIndex = 0;
  while (gtIndex < gt.length && predIndex < pred.length) {
    if (
      gt[gtIndex].ch === pred[predIndex].ch
      && dp[gtIndex][predIndex] === 1 + dp[gtIndex + 1][predIndex + 1]
    ) {
      matches.push({ gtIndex, predIndex });
      gtIndex += 1;
      predIndex += 1;
      continue;
    }
    const skipGt = dp[gtIndex + 1][predIndex];
    const skipPred = dp[gtIndex][predIndex + 1];
    if (skipGt > skipPred) {
      gtIndex += 1;
    } else if (skipPred > skipGt) {
      predIndex += 1;
    } else {
      const gtProgress = (gtIndex + 1) / Math.max(1, gt.length);
      const predProgress = predIndex / Math.max(1, pred.length);
      const skipGtDistance = Math.abs(gtProgress - predProgress);
      const currentGtProgress = gtIndex / Math.max(1, gt.length);
      const skipPredProgress = (predIndex + 1) / Math.max(1, pred.length);
      if (skipGtDistance <= Math.abs(currentGtProgress - skipPredProgress)) {
        gtIndex += 1;
      } else {
        predIndex += 1;
      }
    }
  }
  return matches;
}

function lineBreakPositions(columns: GroundTruthColumn[]): Set<number> {
  const breaks = new Set<number>();
  let position = 0;
  columns.forEach((column, index) => {
    position += segmentVerticalGraphemes(column.text).filter((char) => !isWhitespace(char)).length;
    if (index < columns.length - 1) breaks.add(position);
  });
  return breaks;
}

function computeLineBreakMetrics(
  gtColumns: GroundTruthColumn[],
  predColumns: GroundTruthColumn[],
): { precision: number; recall: number; f1: number } {
  const gtBreaks = lineBreakPositions(gtColumns);
  const predBreaks = lineBreakPositions(predColumns);
  if (gtBreaks.size === 0 && predBreaks.size === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  let matches = 0;
  for (const position of predBreaks) {
    if (gtBreaks.has(position)) matches += 1;
  }
  const precision = predBreaks.size > 0 ? matches / predBreaks.size : 0;
  const recall = gtBreaks.size > 0 ? matches / gtBreaks.size : 0;
  const f1 = precision + recall > 0
    ? 2 * precision * recall / (precision + recall)
    : 0;
  return { precision, recall, f1 };
}

function createGlyphDiagnostics(
  gt: MetricGlyph[],
  pred: MetricGlyph[],
  matches: GlyphMatch[],
  normBase: number,
): HorizontalGlyphDiagnostic[] {
  const diagnostics: HorizontalGlyphDiagnostic[] = [];
  const matchedGt = new Set<number>();
  const matchedPred = new Set<number>();
  for (const match of matches) {
    matchedGt.add(match.gtIndex);
    matchedPred.add(match.predIndex);
    const gtGlyph = gt[match.gtIndex];
    const predGlyph = pred[match.predIndex];
    const positionable = Number.isFinite(gtGlyph.x)
      && Number.isFinite(gtGlyph.y)
      && Number.isFinite(predGlyph.x)
      && Number.isFinite(predGlyph.y);
    const dxNorm = positionable ? (predGlyph.x! - gtGlyph.x!) / normBase : undefined;
    const dyNorm = positionable ? (predGlyph.y! - gtGlyph.y!) / normBase : undefined;
    diagnostics.push({
      matchStatus: "matched",
      ch: gtGlyph.ch,
      gtLineIndex: gtGlyph.lineIndex,
      gtCharIndex: gtGlyph.charIndex,
      gtSequenceIndex: gtGlyph.sequenceIndex,
      predLineIndex: predGlyph.lineIndex,
      predCharIndex: predGlyph.charIndex,
      predSequenceIndex: predGlyph.sequenceIndex,
      gtX: gtGlyph.x,
      gtY: gtGlyph.y,
      predX: predGlyph.x,
      predY: predGlyph.y,
      dxNorm,
      dyNorm,
      distanceNorm: dxNorm !== undefined && dyNorm !== undefined
        ? Math.hypot(dxNorm, dyNorm)
        : undefined,
    });
  }
  gt.forEach((glyph, index) => {
    if (matchedGt.has(index)) return;
    diagnostics.push({
      matchStatus: "gt-unmatched",
      ch: glyph.ch,
      gtLineIndex: glyph.lineIndex,
      gtCharIndex: glyph.charIndex,
      gtSequenceIndex: glyph.sequenceIndex,
      gtX: glyph.x,
      gtY: glyph.y,
    });
  });
  pred.forEach((glyph, index) => {
    if (matchedPred.has(index)) return;
    diagnostics.push({
      matchStatus: "pred-unmatched",
      ch: glyph.ch,
      predLineIndex: glyph.lineIndex,
      predCharIndex: glyph.charIndex,
      predSequenceIndex: glyph.sequenceIndex,
      predX: glyph.x,
      predY: glyph.y,
    });
  });
  return diagnostics;
}

function safeRatio(value: number, base: number, fallback = 1): number {
  return Math.abs(base) > 1e-6 ? value / base : fallback;
}

export function computeHorizontalRegionMetrics(
  gtColumns: GroundTruthColumn[],
  predColumns: GroundTruthColumn[],
  predFontSize: number,
  weights: HorizontalScoreWeights,
): HorizontalMetricComputation {
  if (gtColumns.length === 0 || predColumns.length === 0) {
    return { skipReason: "no_horizontal_lines", glyphDiagnostics: [] };
  }
  const gtFont = median(gtColumns.map((column) => column.estimatedFontSize).filter((value) => value > 0));
  const normBase = predFontSize > 0 ? predFontSize : gtFont > 0 ? gtFont : 1;
  const gtGlyphs = flattenGlyphs(gtColumns);
  const predGlyphs = flattenGlyphs(predColumns);
  const glyphMatches = alignGlyphs(gtGlyphs, predGlyphs);
  const glyphDiagnostics = createGlyphDiagnostics(gtGlyphs, predGlyphs, glyphMatches, normBase);
  const positionedDiagnostics = glyphDiagnostics.filter((item) => (
    item.matchStatus === "matched" && item.distanceNorm !== undefined
  ));
  if (positionedDiagnostics.length === 0) {
    return { skipReason: "no_horizontal_glyph_pairs", glyphDiagnostics };
  }

  const gtSpatial = [...gtColumns].sort((a, b) => (
    quadCenter(columnQuad(a)).y - quadCenter(columnQuad(b)).y
  ));
  const predSpatial = [...predColumns].sort((a, b) => (
    quadCenter(columnQuad(a)).y - quadCenter(columnQuad(b)).y
  ));
  const pairCount = Math.max(gtSpatial.length, predSpatial.length);
  const lineIous: number[] = [];
  const signedLineDx: number[] = [];
  const signedLineDy: number[] = [];
  const lineDistances: number[] = [];
  const widthRatios: number[] = [];
  const widthErrors: number[] = [];
  const heightRatios: number[] = [];
  const heightErrors: number[] = [];
  const angleErrors: number[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    const gtColumn = gtSpatial[index];
    const predColumn = predSpatial[index];
    if (!gtColumn || !predColumn) {
      lineIous.push(0);
      continue;
    }
    const gtQuad = columnQuad(gtColumn);
    const predQuad = columnQuad(predColumn);
    lineIous.push(convexPolygonIoU(gtQuad, predQuad));
    const gtCenter = quadCenter(gtQuad);
    const predCenter = quadCenter(predQuad);
    const dx = (predCenter.x - gtCenter.x) / normBase;
    const dy = (predCenter.y - gtCenter.y) / normBase;
    signedLineDx.push(dx);
    signedLineDy.push(dy);
    lineDistances.push(Math.hypot(dx, dy));
    const gtDimensions = quadDimensions(gtQuad);
    const predDimensions = quadDimensions(predQuad);
    const widthRatio = safeRatio(predDimensions.width, gtDimensions.width);
    const heightRatio = safeRatio(predDimensions.height, gtDimensions.height);
    widthRatios.push(widthRatio);
    widthErrors.push(Math.abs(widthRatio - 1));
    heightRatios.push(heightRatio);
    heightErrors.push(Math.abs(heightRatio - 1));
    if (gtColumn.quad) {
      angleErrors.push(angleDifferenceDeg(quadAngleDeg(gtQuad), quadAngleDeg(predQuad)));
    }
  }

  const signedLineGaps: number[] = [];
  const linePitchRatios: number[] = [];
  const linePitchErrors: number[] = [];
  const adjacentCount = Math.min(gtSpatial.length, predSpatial.length) - 1;
  for (let index = 0; index < adjacentCount; index += 1) {
    const gtCurrent = gtSpatial[index];
    const gtNext = gtSpatial[index + 1];
    const predCurrent = predSpatial[index];
    const predNext = predSpatial[index + 1];
    const gtPitch = quadCenter(columnQuad(gtNext)).y - quadCenter(columnQuad(gtCurrent)).y;
    const predPitch = quadCenter(columnQuad(predNext)).y - quadCenter(columnQuad(predCurrent)).y;
    const gtGap = gtNext.topY - gtCurrent.bottomY;
    const predGap = predNext.topY - predCurrent.bottomY;
    signedLineGaps.push((predGap - gtGap) / normBase);
    if (Math.abs(gtPitch) > 1e-6) {
      const ratio = predPitch / gtPitch;
      linePitchRatios.push(ratio);
      linePitchErrors.push(Math.abs(ratio - 1));
    }
  }

  const gtHull = convexHull(gtSpatial.flatMap(columnQuad));
  const predHull = convexHull(predSpatial.flatMap(columnQuad));
  const blockHullIou = convexPolygonIoU(gtHull, predHull);
  const lineBreak = computeLineBreakMetrics(gtColumns, predColumns);
  const fontSizeRatio = safeRatio(predFontSize, gtFont);
  const fontSizeError = gtFont > 0 ? Math.abs(predFontSize - gtFont) / gtFont : 0;
  const glyphCoverageDenominator = Math.max(gtGlyphs.length, predGlyphs.length);
  const glyphTextMatchCoverage = glyphCoverageDenominator > 0
    ? glyphMatches.length / glyphCoverageDenominator
    : 0;
  const glyphPositionCoverage = glyphCoverageDenominator > 0
    ? positionedDiagnostics.length / glyphCoverageDenominator
    : 0;
  const dxNorms = positionedDiagnostics.map((item) => item.dxNorm!);
  const dyNorms = positionedDiagnostics.map((item) => item.dyNorm!);
  const distances = positionedDiagnostics.map((item) => item.distanceNorm!);

  const signedCharAdvances: number[] = [];
  const charAdvanceRatios: number[] = [];
  const charAdvanceErrors: number[] = [];
  for (let index = 0; index < glyphMatches.length - 1; index += 1) {
    const currentMatch = glyphMatches[index];
    const nextMatch = glyphMatches[index + 1];
    if (
      nextMatch.gtIndex !== currentMatch.gtIndex + 1
      || nextMatch.predIndex !== currentMatch.predIndex + 1
    ) continue;
    const currentGt = gtGlyphs[currentMatch.gtIndex];
    const nextGt = gtGlyphs[nextMatch.gtIndex];
    const currentPred = predGlyphs[currentMatch.predIndex];
    const nextPred = predGlyphs[nextMatch.predIndex];
    if (
      currentGt.lineIndex !== nextGt.lineIndex
      || currentPred.lineIndex !== nextPred.lineIndex
      || !Number.isFinite(currentGt.x)
      || !Number.isFinite(nextGt.x)
      || !Number.isFinite(currentPred.x)
      || !Number.isFinite(nextPred.x)
    ) continue;
    const gtAdvance = nextGt.x! - currentGt.x!;
    const predAdvance = nextPred.x! - currentPred.x!;
    if (Math.abs(gtAdvance) <= 1e-6) continue;
    const ratio = predAdvance / gtAdvance;
    signedCharAdvances.push((predAdvance - gtAdvance) / normBase);
    charAdvanceRatios.push(ratio);
    charAdvanceErrors.push(Math.abs(ratio - 1));
  }

  const charCenterQuality = mean(distances.map((distance) => 1 - clamp01(distance)));
  const lineCountMatch = gtColumns.length === predColumns.length ? 1 : 0;
  const lineQuadIouMean = mean(lineIous);
  const compositeScore =
    weights.lineCountMatch * lineCountMatch
    + weights.lineQuadIouMean * lineQuadIouMean
    + weights.blockHullIou * blockHullIou
    + weights.fontSizeError * (1 - clamp01(fontSizeError))
    + weights.lineBreakF1 * lineBreak.f1
    + weights.glyphPositionCoverage * glyphPositionCoverage
    + weights.charCenterQuality * charCenterQuality;

  return {
    glyphDiagnostics,
    metrics: {
      lineCountMatch,
      lineCountDiff: predColumns.length - gtColumns.length,
      lineQuadIouMean,
      lineQuadIouMin: lineIous.length > 0 ? Math.min(...lineIous) : 0,
      blockHullIou,
      sourceQuadCoverage: gtColumns.length > 0
        ? gtColumns.filter((column) => column.quad).length / gtColumns.length
        : 0,
      fontSizeRatio,
      fontSizeError,
      signedLineCenterDxNormMean: mean(signedLineDx),
      signedLineCenterDyNormMean: mean(signedLineDy),
      lineCenterDistanceNormMean: mean(lineDistances),
      lineCenterDistanceNormP95: percentile(lineDistances, 95),
      lineCenterDistanceNormMax: lineDistances.length > 0 ? Math.max(...lineDistances) : 0,
      lineWidthRatioMean: meanOr(widthRatios, 1),
      lineWidthErrorMean: mean(widthErrors),
      lineHeightRatioMean: meanOr(heightRatios, 1),
      lineHeightErrorMean: mean(heightErrors),
      signedLineGapNormMean: mean(signedLineGaps),
      linePitchRatioMean: meanOr(linePitchRatios, 1),
      linePitchErrorMean: mean(linePitchErrors),
      lineAngleErrorDegMean: mean(angleErrors),
      lineAngleErrorDegMax: angleErrors.length > 0 ? Math.max(...angleErrors) : 0,
      lineBreakPrecision: lineBreak.precision,
      lineBreakRecall: lineBreak.recall,
      lineBreakF1: lineBreak.f1,
      gtGlyphCount: gtGlyphs.length,
      predGlyphCount: predGlyphs.length,
      matchedGlyphCount: glyphMatches.length,
      positionedGlyphCount: positionedDiagnostics.length,
      glyphTextMatchCoverage,
      glyphPositionCoverage,
      signedCharDxNormMean: mean(dxNorms),
      signedCharDyNormMean: mean(dyNorms),
      charDxNormMean: mean(dxNorms.map(Math.abs)),
      charDyNormMean: mean(dyNorms.map(Math.abs)),
      charDistanceNormMean: mean(distances),
      charDistanceNormMedian: median(distances),
      charDistanceNormP95: percentile(distances, 95),
      charDistanceNormMax: distances.length > 0 ? Math.max(...distances) : 0,
      charDistanceOverHalfEmRate: distances.filter((distance) => distance > 0.5).length / distances.length,
      charDistanceOverOneEmRate: distances.filter((distance) => distance > 1).length / distances.length,
      signedCharAdvanceNormMean: mean(signedCharAdvances),
      charAdvanceRatioMean: meanOr(charAdvanceRatios, 1),
      charAdvanceErrorMean: mean(charAdvanceErrors),
      charCenterQuality,
      compositeScore,
    },
  };
}
