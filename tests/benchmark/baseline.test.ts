import { describe, expect, it } from "vitest";
import {
  buildBaselineComparisons,
  buildTypesetBaseline,
  getTypesetBaselineSchemaError,
  type TypesetBaseline,
} from "../../benchmark/typeset/src/baseline";
import type { BenchmarkSummary, HorizontalBenchmarkSummary } from "../../benchmark/typeset/src/types";

function horizontalSummary(scoredRegionCount: number): HorizontalBenchmarkSummary {
  return {
    scoredRegionCount,
    skippedRegionCount: 0,
    avgCompositeScore: 0.6,
    avgLineQuadIouMean: 0.5,
    avgBlockHullIou: 0.7,
    avgSourceQuadCoverage: 1,
    avgFontSizeError: 0.1,
    avgLineDyNormMean: 0.2,
    avgLineCenterDistanceNorm: 0.4,
    avgLineWidthError: 0.2,
    avgLineHeightError: 0.1,
    avgLinePitchError: 0.1,
    avgLineAngleErrorDeg: 2,
    avgLineBreakF1: 0.9,
    gtGlyphCount: 10,
    predGlyphCount: 10,
    matchedGlyphCount: 10,
    positionedGlyphCount: 10,
    glyphTextMatchCoverage: 1,
    glyphPositionCoverage: 1,
    signedCharDxNormMean: 0.1,
    signedCharDyNormMean: 0.1,
    charDxNormMean: 0.2,
    charDxScoreNormMean: 0.2,
    charDyNormMean: 0.2,
    charDistanceNormMean: 0.3,
    charDistanceNormMedian: 0.2,
    charDistanceNormP95: 0.8,
    charDistanceNormMax: 1,
    charDistanceOverHalfEmRate: 0.2,
    charDistanceOverOneEmRate: 0.1,
    avgCharAdvanceError: 0.1,
    charCenterQuality: 0.7,
  };
}

function makeSummary(horizontalScored = 1): BenchmarkSummary {
  return {
    schemaVersion: 3,
    generatedAt: "2026-07-11T00:00:00.000Z",
    imageCount: 1,
    totalRegionCount: 1,
    skippedRegionCount: 0,
    avgCompositeScore: 0.9,
    avgGlyphQualityCoverage: 1,
    avgGlyphOrientationAccuracy: 1,
    avgRunContinuityRate: 1,
    avgVerticalItemCenterAlignment: 1,
    avgGlyphQualityScore: 1,
    avgColumnIouMean: 0.8,
    avgFontSizeError: 0.1,
    avgSignedColumnDxNorm: 0,
    avgColumnDxNorm: 0.1,
    avgSignedColumnGapNorm: 0,
    avgColumnPitchRatio: 1,
    avgSignedCharDyNorm: 0,
    avgCharDyNorm: 0.1,
    avgSignedCharAdvanceNorm: 0,
    avgCharAdvanceRatio: 1,
    columnCountMatchRate: 1,
    sourceGeometryUsableRegionCount: 1,
    sourceGeometryRejectedRegionCount: 0,
    sourceGeometrySpatialOrderMismatchCount: 0,
    sourceGeometryRejectedReasons: {},
    horizontal: horizontalSummary(horizontalScored),
    images: [],
  };
}

describe("typeset baseline horizontal compatibility", () => {
  it("rejects v2 baselines after the horizontal scoring definition changes", () => {
    expect(getTypesetBaselineSchemaError({ schemaVersion: 2 })).toContain(
      "schema v2 is incompatible with v3",
    );
    expect(getTypesetBaselineSchemaError({ schemaVersion: 3 })).toBeUndefined();
  });

  it("omits horizontal baseline fields when no horizontal region is scored", () => {
    expect(buildTypesetBaseline(makeSummary(0)).horizontal).toBeUndefined();
  });

  it("skips horizontal comparisons for a legacy baseline", () => {
    const baseline = buildTypesetBaseline(makeSummary(0));
    const result = buildBaselineComparisons(baseline, makeSummary(1));

    expect(result.horizontalStatus).toBe("missing-baseline");
    expect(result.metrics.every((metric) => metric.name.startsWith("Vertical"))).toBe(true);
  });

  it("adds horizontal comparisons after an explicit horizontal baseline", () => {
    const baseline = buildTypesetBaseline(makeSummary(1));
    const result = buildBaselineComparisons(baseline, makeSummary(1));

    expect(result.horizontalStatus).toBe("comparable");
    expect(result.metrics.some((metric) => metric.name === "Horizontal Char Distance Norm")).toBe(true);
  });

  it("reports missing current horizontal regions as a contract failure", () => {
    const baseline = buildTypesetBaseline(makeSummary(1)) as TypesetBaseline;
    const result = buildBaselineComparisons(baseline, makeSummary(0));

    expect(result.horizontalStatus).toBe("missing-current");
  });
});
