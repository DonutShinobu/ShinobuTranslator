import type {
  GroundTruthColumn,
  RegionMetrics,
  ScoreWeights,
} from "./types";

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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computeRegionMetrics(
  gtColumns: GroundTruthColumn[],
  predColumns: GroundTruthColumn[],
  predFontSize: number,
  weights: ScoreWeights,
): Omit<RegionMetrics, "regionId" | "skipped" | "skipReason"> {
  const gtN = gtColumns.length;
  const predN = predColumns.length;
  const columnCountMatch = gtN === predN ? 1 : 0;
  const columnCountDiff = predN - gtN;
  const pairCount = Math.max(gtN, predN);

  const ious: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    if (i < gtN && i < predN) {
      ious.push(columnIoU(gtColumns[i], predColumns[i]));
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

  const dxNorms: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const dx = predColumns[i].centerX - gtColumns[i].centerX;
    const norm = gtColumns[i].width > 0 ? dx / gtColumns[i].width : 0;
    dxNorms.push(Math.abs(norm));
  }
  const columnDxNormMean = dxNorms.length > 0
    ? dxNorms.reduce((a, b) => a + b, 0) / dxNorms.length
    : 0;
  const columnDxNormMax = dxNorms.length > 0 ? Math.max(...dxNorms) : 0;

  const dTops: number[] = [];
  const dBottoms: number[] = [];
  const heightRatios: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtH = gtColumns[i].height;
    if (gtH > 0) {
      dTops.push((predColumns[i].topY - gtColumns[i].topY) / gtH);
      dBottoms.push((predColumns[i].bottomY - gtColumns[i].bottomY) / gtH);
      heightRatios.push(predColumns[i].height / gtH);
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

  const allDyNorms: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtCenters = gtColumns[i].charCenters;
    const predCenters = predColumns[i].charCenters;
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
      allDyNorms.push(Math.abs(norm));
    }
  }
  const charDyNormMean = allDyNorms.length > 0
    ? allDyNorms.reduce((a, b) => a + b, 0) / allDyNorms.length
    : 0;
  const charDyNormMax = allDyNorms.length > 0 ? Math.max(...allDyNorms) : 0;
  const charDyNormP95 = percentile(allDyNorms, 95);

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
    columnDxNormMean,
    columnDxNormMax,
    dTopNormMean,
    dBottomNormMean,
    heightRatioMean,
    charDyNormMean,
    charDyNormMax,
    charDyNormP95,
    compositeScore,
  };
}
