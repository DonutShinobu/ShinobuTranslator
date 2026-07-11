import type { BenchmarkSummary } from "./types";

export type BaselineMetricComparison = {
  name: string;
  baseline: number;
  current: number;
  higherIsBetter: boolean;
};

export type TypesetBaseline = {
  schemaVersion?: 2;
  generatedAt: string;
  avgCompositeScore: number;
  avgColumnIouMean: number;
  avgFontSizeError: number;
  avgSignedColumnDxNorm: number;
  avgColumnDxNorm: number;
  avgSignedColumnGapNorm: number;
  avgColumnPitchRatio: number;
  avgSignedCharDyNorm: number;
  avgCharDyNorm: number;
  avgSignedCharAdvanceNorm: number;
  avgCharAdvanceRatio: number;
  columnCountMatchRate: number;
  horizontal?: {
    scoredRegionCount: number;
    avgCompositeScore: number;
    avgLineQuadIouMean: number;
    charDistanceNormMean: number;
    charDistanceOverOneEmRate: number;
    glyphPositionCoverage: number;
  };
};

export type BaselineComparisonResult = {
  metrics: BaselineMetricComparison[];
  horizontalStatus: "missing-baseline" | "missing-current" | "comparable";
};

export function buildTypesetBaseline(summary: BenchmarkSummary): TypesetBaseline {
  return {
    schemaVersion: 2,
    generatedAt: summary.generatedAt,
    avgCompositeScore: summary.avgCompositeScore,
    avgColumnIouMean: summary.avgColumnIouMean,
    avgFontSizeError: summary.avgFontSizeError,
    avgSignedColumnDxNorm: summary.avgSignedColumnDxNorm,
    avgColumnDxNorm: summary.avgColumnDxNorm,
    avgSignedColumnGapNorm: summary.avgSignedColumnGapNorm,
    avgColumnPitchRatio: summary.avgColumnPitchRatio,
    avgSignedCharDyNorm: summary.avgSignedCharDyNorm,
    avgCharDyNorm: summary.avgCharDyNorm,
    avgSignedCharAdvanceNorm: summary.avgSignedCharAdvanceNorm,
    avgCharAdvanceRatio: summary.avgCharAdvanceRatio,
    columnCountMatchRate: summary.columnCountMatchRate,
    horizontal: summary.horizontal.scoredRegionCount > 0
      ? {
          scoredRegionCount: summary.horizontal.scoredRegionCount,
          avgCompositeScore: summary.horizontal.avgCompositeScore,
          avgLineQuadIouMean: summary.horizontal.avgLineQuadIouMean,
          charDistanceNormMean: summary.horizontal.charDistanceNormMean,
          charDistanceOverOneEmRate: summary.horizontal.charDistanceOverOneEmRate,
          glyphPositionCoverage: summary.horizontal.glyphPositionCoverage,
        }
      : undefined,
  };
}

export function buildBaselineComparisons(
  baseline: TypesetBaseline,
  current: BenchmarkSummary,
): BaselineComparisonResult {
  const metrics: BaselineMetricComparison[] = [
    { name: "Vertical Composite Score", baseline: baseline.avgCompositeScore, current: current.avgCompositeScore, higherIsBetter: true },
    { name: "Vertical Column IoU", baseline: baseline.avgColumnIouMean, current: current.avgColumnIouMean, higherIsBetter: true },
    { name: "Vertical Font Size Error", baseline: baseline.avgFontSizeError, current: current.avgFontSizeError, higherIsBetter: false },
    { name: "Vertical Column Dx Norm", baseline: baseline.avgColumnDxNorm, current: current.avgColumnDxNorm, higherIsBetter: false },
    { name: "Vertical Char Dy Norm", baseline: baseline.avgCharDyNorm, current: current.avgCharDyNorm, higherIsBetter: false },
    { name: "Vertical Col Count Match", baseline: baseline.columnCountMatchRate, current: current.columnCountMatchRate, higherIsBetter: true },
  ];
  if (!baseline.horizontal) {
    return { metrics, horizontalStatus: "missing-baseline" };
  }
  if (current.horizontal.scoredRegionCount === 0) {
    return { metrics, horizontalStatus: "missing-current" };
  }
  metrics.push(
    { name: "Horizontal Composite Score", baseline: baseline.horizontal.avgCompositeScore, current: current.horizontal.avgCompositeScore, higherIsBetter: true },
    { name: "Horizontal Line Quad IoU", baseline: baseline.horizontal.avgLineQuadIouMean, current: current.horizontal.avgLineQuadIouMean, higherIsBetter: true },
    { name: "Horizontal Char Distance Norm", baseline: baseline.horizontal.charDistanceNormMean, current: current.horizontal.charDistanceNormMean, higherIsBetter: false },
    { name: "Horizontal Char Distance > 1em", baseline: baseline.horizontal.charDistanceOverOneEmRate, current: current.horizontal.charDistanceOverOneEmRate, higherIsBetter: false },
    { name: "Horizontal Glyph Position Coverage", baseline: baseline.horizontal.glyphPositionCoverage, current: current.horizontal.glyphPositionCoverage, higherIsBetter: true },
  );
  return { metrics, horizontalStatus: "comparable" };
}
