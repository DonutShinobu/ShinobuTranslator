import type { BenchmarkSummary } from "./types";

export const TYPESET_BASELINE_SCHEMA_VERSION = 3 as const;

export type BaselineMetricComparison = {
  name: string;
  baseline: number;
  current: number;
  higherIsBetter: boolean;
};

export type TypesetBaseline = {
  schemaVersion: typeof TYPESET_BASELINE_SCHEMA_VERSION;
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
    avgLineDyNormMean: number;
    charDxScoreNormMean: number;
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
    schemaVersion: TYPESET_BASELINE_SCHEMA_VERSION,
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
          avgLineDyNormMean: summary.horizontal.avgLineDyNormMean,
          charDxScoreNormMean: summary.horizontal.charDxScoreNormMean,
          charDistanceNormMean: summary.horizontal.charDistanceNormMean,
          charDistanceOverOneEmRate: summary.horizontal.charDistanceOverOneEmRate,
          glyphPositionCoverage: summary.horizontal.glyphPositionCoverage,
        }
      : undefined,
  };
}

export function getTypesetBaselineSchemaError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) {
    return `Baseline schema is missing and is incompatible with v${TYPESET_BASELINE_SCHEMA_VERSION}; regenerate it with --update-baseline.`;
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== TYPESET_BASELINE_SCHEMA_VERSION) {
    return `Baseline schema v${String(schemaVersion)} is incompatible with v${TYPESET_BASELINE_SCHEMA_VERSION}; regenerate it with --update-baseline.`;
  }
  return undefined;
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
    { name: "Horizontal Line Y Error Norm", baseline: baseline.horizontal.avgLineDyNormMean, current: current.horizontal.avgLineDyNormMean, higherIsBetter: false },
    { name: "Horizontal Char X Score Error Norm", baseline: baseline.horizontal.charDxScoreNormMean, current: current.horizontal.charDxScoreNormMean, higherIsBetter: false },
    { name: "Horizontal Char Distance Norm", baseline: baseline.horizontal.charDistanceNormMean, current: current.horizontal.charDistanceNormMean, higherIsBetter: false },
    { name: "Horizontal Char Distance > 1em", baseline: baseline.horizontal.charDistanceOverOneEmRate, current: current.horizontal.charDistanceOverOneEmRate, higherIsBetter: false },
    { name: "Horizontal Glyph Position Coverage", baseline: baseline.horizontal.glyphPositionCoverage, current: current.horizontal.glyphPositionCoverage, higherIsBetter: true },
  );
  return { metrics, horizontalStatus: "comparable" };
}
