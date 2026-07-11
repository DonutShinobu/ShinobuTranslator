import type { HorizontalGlyphDiagnostic } from "./horizontal-metrics";
import { clamp01, mean, median, percentile } from "./metric-utils";
import type {
  HorizontalBenchmarkSummary,
  HorizontalRegionMetrics,
} from "./types";

export type ReportedHorizontalGlyphDiagnostic = HorizontalGlyphDiagnostic & {
  imageFile: string;
  regionId: string;
};

export function summarizeHorizontalMetrics(
  regions: HorizontalRegionMetrics[],
  skippedRegionCount: number,
  glyphDiagnostics: ReportedHorizontalGlyphDiagnostic[],
): HorizontalBenchmarkSummary {
  const positioned = glyphDiagnostics.filter((item) => (
    item.matchStatus === "matched"
    && item.dxNorm !== undefined
    && item.dyNorm !== undefined
    && item.distanceNorm !== undefined
  ));
  const dxNorms = positioned.map((item) => item.dxNorm!);
  const dyNorms = positioned.map((item) => item.dyNorm!);
  const distances = positioned.map((item) => item.distanceNorm!);
  const coverageDenominator = regions.reduce(
    (sum, region) => sum + Math.max(region.gtGlyphCount, region.predGlyphCount),
    0,
  );
  const matchedGlyphCount = regions.reduce((sum, region) => sum + region.matchedGlyphCount, 0);
  const positionedGlyphCount = positioned.length;
  const charDxScoreNormMean = coverageDenominator > 0
    ? (
        dxNorms.reduce((sum, dx) => sum + Math.abs(dx), 0)
        + coverageDenominator
        - positionedGlyphCount
      ) / coverageDenominator
    : 1;

  return {
    scoredRegionCount: regions.length,
    skippedRegionCount,
    avgCompositeScore: mean(regions.map((region) => region.compositeScore)),
    avgLineQuadIouMean: mean(regions.map((region) => region.lineQuadIouMean)),
    avgBlockHullIou: mean(regions.map((region) => region.blockHullIou)),
    avgSourceQuadCoverage: mean(regions.map((region) => region.sourceQuadCoverage)),
    avgFontSizeError: mean(regions.map((region) => region.fontSizeError)),
    avgLineDyNormMean: mean(regions.map((region) => region.lineDyNormMean)),
    avgLineCenterDistanceNorm: mean(regions.map((region) => region.lineCenterDistanceNormMean)),
    avgLineWidthError: mean(regions.map((region) => region.lineWidthErrorMean)),
    avgLineHeightError: mean(regions.map((region) => region.lineHeightErrorMean)),
    avgLinePitchError: mean(regions.map((region) => region.linePitchErrorMean)),
    avgLineAngleErrorDeg: mean(regions.map((region) => region.lineAngleErrorDegMean)),
    avgLineBreakF1: mean(regions.map((region) => region.lineBreakF1)),
    gtGlyphCount: regions.reduce((sum, region) => sum + region.gtGlyphCount, 0),
    predGlyphCount: regions.reduce((sum, region) => sum + region.predGlyphCount, 0),
    matchedGlyphCount,
    positionedGlyphCount,
    glyphTextMatchCoverage: coverageDenominator > 0 ? matchedGlyphCount / coverageDenominator : 0,
    glyphPositionCoverage: coverageDenominator > 0 ? positionedGlyphCount / coverageDenominator : 0,
    signedCharDxNormMean: mean(dxNorms),
    signedCharDyNormMean: mean(dyNorms),
    charDxNormMean: mean(dxNorms.map(Math.abs)),
    charDxScoreNormMean,
    charDyNormMean: mean(dyNorms.map(Math.abs)),
    charDistanceNormMean: mean(distances),
    charDistanceNormMedian: median(distances),
    charDistanceNormP95: percentile(distances, 95),
    charDistanceNormMax: distances.length > 0 ? Math.max(...distances) : 0,
    charDistanceOverHalfEmRate: distances.length > 0
      ? distances.filter((distance) => distance > 0.5).length / distances.length
      : 0,
    charDistanceOverOneEmRate: distances.length > 0
      ? distances.filter((distance) => distance > 1).length / distances.length
      : 0,
    avgCharAdvanceError: mean(regions.map((region) => region.charAdvanceErrorMean)),
    charCenterQuality: mean(distances.map((distance) => 1 - clamp01(distance))),
  };
}
