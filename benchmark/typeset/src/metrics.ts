import type {
  GroundTruthColumn,
  ScoreWeights,
  VerticalMetricValues,
} from "./types";
import { clamp01, mean, meanOr, median, percentile } from "./metric-utils";

function rectIntersectionArea(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function columnIoU(gt: GroundTruthColumn, pred: GroundTruthColumn): number {
  const gtX = gt.centerX - gt.width / 2;
  const predX = pred.centerX - pred.width / 2;
  const inter = rectIntersectionArea(
    gtX, gt.topY, gt.width, gt.height,
    predX, pred.topY, pred.width, pred.height,
  );
  const gtArea = gt.width * gt.height;
  const predArea = pred.width * pred.height;
  const union = gtArea + predArea - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function positiveMedian(values: number[], fallback: number): number {
  const positives = values.filter((v) => v > 0);
  return positives.length > 0 ? median(positives) : fallback;
}

function columnLeft(column: GroundTruthColumn): number {
  return column.centerX - column.width / 2;
}

function columnRight(column: GroundTruthColumn): number {
  return column.centerX + column.width / 2;
}

function columnGap(rightColumn: GroundTruthColumn, leftColumn: GroundTruthColumn): number {
  return columnLeft(rightColumn) - columnRight(leftColumn);
}

function columnPitch(rightColumn: GroundTruthColumn, leftColumn: GroundTruthColumn): number {
  return Math.abs(rightColumn.centerX - leftColumn.centerX);
}

function columnsRightToLeft(columns: GroundTruthColumn[]): GroundTruthColumn[] {
  return [...columns].sort((a, b) => b.centerX - a.centerX);
}

function averageCharAdvance(column: GroundTruthColumn): number | undefined {
  if (column.charCenters.length < 2) return undefined;
  const deltas: number[] = [];
  for (let i = 0; i < column.charCenters.length - 1; i++) {
    const dy = column.charCenters[i + 1].y - column.charCenters[i].y;
    if (Number.isFinite(dy)) deltas.push(dy);
  }
  return deltas.length > 0 ? mean(deltas) : undefined;
}

export function computeRegionMetrics(
  gtColumns: GroundTruthColumn[],
  predColumns: GroundTruthColumn[],
  predFontSize: number,
  weights: ScoreWeights,
): VerticalMetricValues {
  const gtN = gtColumns.length;
  const predN = predColumns.length;
  const columnCountMatch = gtN === predN ? 1 : 0;
  const columnCountDiff = predN - gtN;
  const pairCount = Math.max(gtN, predN);
  const gtSpatialColumns = columnsRightToLeft(gtColumns);
  const predSpatialColumns = columnsRightToLeft(predColumns);

  const ious: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    if (i < gtN && i < predN) {
      ious.push(columnIoU(gtSpatialColumns[i], predSpatialColumns[i]));
    } else {
      ious.push(0);
    }
  }
  const columnIouMean = ious.length > 0
    ? ious.reduce((a, b) => a + b, 0) / ious.length
    : 0;
  const columnIouMin = ious.length > 0 ? Math.min(...ious) : 0;

  const gtFontSizes = gtColumns.map((c) => c.estimatedFontSize);
  const gtFont = gtFontSizes.length > 0 ? median(gtFontSizes) : predFontSize;
  const fontSizeRatio = gtFont > 0 ? predFontSize / gtFont : 1;
  const fontSizeError = gtFont > 0
    ? Math.abs(predFontSize - gtFont) / gtFont
    : 0;

  const signedDxNorms: number[] = [];
  const dxNorms: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const dx = predSpatialColumns[i].centerX - gtSpatialColumns[i].centerX;
    const norm = gtSpatialColumns[i].width > 0 ? dx / gtSpatialColumns[i].width : 0;
    signedDxNorms.push(norm);
    dxNorms.push(Math.abs(norm));
  }
  const signedColumnDxNormMean = mean(signedDxNorms);
  const columnDxNormMean = mean(dxNorms);
  const columnDxNormMax = dxNorms.length > 0 ? Math.max(...dxNorms) : 0;

  const gapNormBase = positiveMedian(gtColumns.map((c) => c.width), gtFont || predFontSize || 1);
  const signedColumnGapNorms: number[] = [];
  const columnPitchRatios: number[] = [];
  for (let i = 0; i < Math.min(gtSpatialColumns.length, predSpatialColumns.length) - 1; i++) {
    const gtGap = columnGap(gtSpatialColumns[i], gtSpatialColumns[i + 1]);
    const predGap = columnGap(predSpatialColumns[i], predSpatialColumns[i + 1]);
    const gtPitch = columnPitch(gtSpatialColumns[i], gtSpatialColumns[i + 1]);
    const predPitch = columnPitch(predSpatialColumns[i], predSpatialColumns[i + 1]);
    signedColumnGapNorms.push((predGap - gtGap) / gapNormBase);
    if (gtPitch > 1e-6) {
      columnPitchRatios.push(predPitch / gtPitch);
    }
  }
  const signedColumnGapNormMean = mean(signedColumnGapNorms);
  const columnPitchRatioMean = meanOr(columnPitchRatios, 1);

  const dTops: number[] = [];
  const dBottoms: number[] = [];
  const heightRatios: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtH = gtSpatialColumns[i].height;
    if (gtH > 0) {
      dTops.push((predSpatialColumns[i].topY - gtSpatialColumns[i].topY) / gtH);
      dBottoms.push((predSpatialColumns[i].bottomY - gtSpatialColumns[i].bottomY) / gtH);
      heightRatios.push(predSpatialColumns[i].height / gtH);
    }
  }
  const dTopNormMean = dTops.length > 0
    ? dTops.reduce((a, b) => a + Math.abs(b), 0) / dTops.length
    : 0;
  const dBottomNormMean = dBottoms.length > 0
    ? dBottoms.reduce((a, b) => a + Math.abs(b), 0) / dBottoms.length
    : 0;
  const heightRatioMean = heightRatios.length > 0
    ? heightRatios.reduce((a, b) => a + b, 0) / heightRatios.length
    : 0;

  const signedDyNorms: number[] = [];
  const allDyNorms: number[] = [];
  const signedCharAdvanceNorms: number[] = [];
  const charAdvanceRatios: number[] = [];
  for (let i = 0; i < Math.min(gtSpatialColumns.length, predSpatialColumns.length); i++) {
    const gtAdvance = averageCharAdvance(gtSpatialColumns[i]);
    const predAdvance = averageCharAdvance(predSpatialColumns[i]);
    if (
      gtAdvance !== undefined &&
      predAdvance !== undefined &&
      Math.abs(gtAdvance) > 1e-6
    ) {
      const advanceNormBase = predFontSize > 0 ? predFontSize : Math.abs(gtAdvance);
      signedCharAdvanceNorms.push((predAdvance - gtAdvance) / advanceNormBase);
      charAdvanceRatios.push(predAdvance / gtAdvance);
    }
  }

  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtCenters = gtSpatialColumns[i].charCenters;
    const predCenters = predSpatialColumns[i].charCenters;
    const gtLen = gtCenters.length;
    const predLen = predCenters.length;
    if (gtLen === 0 || predLen === 0) continue;
    for (let j = 0; j < gtLen; j++) {
      const predIdx = gtLen === predLen
        ? j
        : Math.round(j * predLen / gtLen);
      if (predIdx >= predLen) continue;
      const dy = predCenters[predIdx].y - gtCenters[j].y;
      const norm = predFontSize > 0 ? dy / predFontSize : 0;
      signedDyNorms.push(norm);
      allDyNorms.push(Math.abs(norm));
    }
  }
  const signedCharDyNormMean = mean(signedDyNorms);
  const charDyNormMean = mean(allDyNorms);
  const charDyNormMax = allDyNorms.length > 0 ? Math.max(...allDyNorms) : 0;
  const charDyNormP95 = percentile(allDyNorms, 95);
  const signedCharAdvanceNormMean = mean(signedCharAdvanceNorms);
  const charAdvanceRatioMean = meanOr(charAdvanceRatios, 1);

  const compositeScore =
    weights.columnCountMatch * columnCountMatch +
    weights.columnIouMean * columnIouMean +
    weights.fontSizeError * (1 - clamp01(fontSizeError)) +
    weights.columnDxNorm * (1 - clamp01(columnDxNormMean)) +
    weights.charDyNorm * (1 - clamp01(charDyNormMean));

  return {
    columnCountMatch,
    columnCountDiff,
    columnIouMean,
    columnIouMin,
    fontSizeRatio,
    fontSizeError,
    signedColumnDxNormMean,
    columnDxNormMean,
    columnDxNormMax,
    signedColumnGapNormMean,
    columnPitchRatioMean,
    dTopNormMean,
    dBottomNormMean,
    heightRatioMean,
    signedCharDyNormMean,
    charDyNormMean,
    charDyNormMax,
    charDyNormP95,
    signedCharAdvanceNormMean,
    charAdvanceRatioMean,
    compositeScore,
  };
}
