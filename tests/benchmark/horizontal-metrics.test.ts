import { describe, expect, it } from "vitest";
import {
  computeHorizontalRegionMetrics,
  convexPolygonIoU,
} from "../../benchmark/typeset/src/horizontal-metrics";
import type {
  GroundTruthColumn,
  HorizontalScoreWeights,
} from "../../benchmark/typeset/src/types";

const weights: HorizontalScoreWeights = {
  lineCountMatch: 0.2,
  lineQuadIouMean: 0.3,
  fontSizeError: 0.2,
  lineDyNorm: 0.15,
  charDxNorm: 0.15,
};

function makeLine(
  text: string,
  y = 0,
  centers?: Array<{ x?: number; y: number }>,
  overrides: Partial<GroundTruthColumn> = {},
): GroundTruthColumn {
  const chars = [...text];
  const width = Math.max(20, chars.length * 20);
  return {
    index: 0,
    text,
    charCount: chars.length,
    centerX: width / 2,
    topY: y,
    bottomY: y + 20,
    width,
    height: 20,
    estimatedFontSize: 20,
    charCenters: centers ?? chars.map((_, index) => ({ x: 10 + index * 20, y: y + 10 })),
    quad: [
      { x: 0, y },
      { x: width, y },
      { x: width, y: y + 20 },
      { x: 0, y: y + 20 },
    ],
    ...overrides,
  };
}

describe("computeHorizontalRegionMetrics", () => {
  it("scores identical horizontal lines and glyph centers as perfect", () => {
    const line = makeLine("横排文字");
    const result = computeHorizontalRegionMetrics([line], [line], 20, weights);

    expect(result.skipReason).toBeUndefined();
    expect(result.metrics?.lineQuadIouMean).toBeCloseTo(1, 6);
    expect(result.metrics?.blockHullIou).toBeCloseTo(1, 6);
    expect(result.metrics?.glyphPositionCoverage).toBe(1);
    expect(result.metrics?.charDistanceNormMean).toBe(0);
    expect(result.metrics?.compositeScore).toBeCloseTo(1, 6);
  });

  it("measures signed X/Y offsets and Euclidean distance in fitted-font em", () => {
    const gt = makeLine("ab", 0, [{ x: 10, y: 10 }, { x: 30, y: 10 }]);
    const pred = makeLine("ab", 0, [{ x: 16, y: 18 }, { x: 36, y: 18 }]);
    const metrics = computeHorizontalRegionMetrics([gt], [pred], 20, weights).metrics!;

    expect(metrics.signedCharDxNormMean).toBeCloseTo(0.3, 6);
    expect(metrics.signedCharDyNormMean).toBeCloseTo(0.4, 6);
    expect(metrics.charDistanceNormMean).toBeCloseTo(0.5, 6);
    expect(metrics.charDxScoreNormMean).toBeCloseTo(0.3, 6);
  });

  it("normalizes line Y error by GT line height", () => {
    const gt = makeLine("ab", 0);
    const pred = makeLine("ab", 10);
    const metrics = computeHorizontalRegionMetrics([gt], [pred], 20, weights).metrics!;

    expect(metrics.lineDyNormMean).toBeCloseTo(0.5, 6);
  });

  it("penalizes font-size error only once in the symmetric composite", () => {
    const line = makeLine("ab");
    const metrics = computeHorizontalRegionMetrics([line], [line], 10, weights).metrics!;

    expect(metrics.fontSizeError).toBeCloseTo(0.5, 6);
    expect(metrics.compositeScore).toBeCloseTo(0.9, 6);
  });

  it("uses true quad IoU and angle for rotated lines", () => {
    const quad = [
      { x: 0, y: 0 },
      { x: 40, y: 4 },
      { x: 38, y: 24 },
      { x: -2, y: 20 },
    ] as const;
    const line = makeLine("ab", 0, undefined, { quad: [...quad] });
    const metrics = computeHorizontalRegionMetrics([line], [line], 20, weights).metrics!;

    expect(convexPolygonIoU([...quad], [...quad])).toBeCloseTo(1, 6);
    expect(metrics.lineQuadIouMean).toBeCloseTo(1, 6);
    expect(metrics.lineAngleErrorDegMean).toBeCloseTo(0, 6);
  });

  it("aligns flattened text across reflow while lowering line-break F1", () => {
    const gt = [makeLine("abcd", 0), makeLine("ef", 30)];
    const pred = [makeLine("abc", 0), makeLine("def", 30)];
    const metrics = computeHorizontalRegionMetrics(gt, pred, 20, weights).metrics!;

    expect(metrics.matchedGlyphCount).toBe(6);
    expect(metrics.glyphTextMatchCoverage).toBe(1);
    expect(metrics.lineBreakF1).toBe(0);
  });

  it("uses ordered character matching for repetitions and insertions", () => {
    const gt = makeLine("aaba");
    const pred = makeLine("aaXba");
    const metrics = computeHorizontalRegionMetrics([gt], [pred], 20, weights).metrics!;

    expect(metrics.matchedGlyphCount).toBe(4);
    expect(metrics.glyphTextMatchCoverage).toBeCloseTo(0.8, 6);
  });

  it("counts unmatched glyphs as one-em X error in the score denominator", () => {
    const gt = makeLine("abc");
    const pred = makeLine(
      "ab",
      0,
      [{ x: 10, y: 10 }, { x: 30, y: 10 }],
      {
        centerX: 30,
        width: 60,
        quad: [
          { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 0, y: 20 },
        ],
      },
    );
    const metrics = computeHorizontalRegionMetrics([gt], [pred], 20, weights).metrics!;

    expect(metrics.glyphPositionCoverage).toBeCloseTo(2 / 3, 6);
    expect(metrics.charDxScoreNormMean).toBeCloseTo(1 / 3, 6);
    expect(metrics.compositeScore).toBeCloseTo(0.95, 6);
  });

  it("reports outlier percentiles and threshold rates", () => {
    const gt = makeLine("abc", 0, [
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 50, y: 10 },
    ]);
    const pred = makeLine("abc", 0, [
      { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 90, y: 10 },
    ]);
    const metrics = computeHorizontalRegionMetrics([gt], [pred], 20, weights).metrics!;

    expect(metrics.charDistanceNormMean).toBeCloseTo(2 / 3, 6);
    expect(metrics.charDistanceNormP95).toBeCloseTo(1.8, 6);
    expect(metrics.charDistanceNormMax).toBe(2);
    expect(metrics.charDistanceOverHalfEmRate).toBeCloseTo(1 / 3, 6);
    expect(metrics.charDistanceOverOneEmRate).toBeCloseTo(1 / 3, 6);
  });

  it("penalizes unlocatable horizontal X coordinates without skipping the region", () => {
    const gt = makeLine("ab", 0, [{ y: 10 }, { y: 10 }]);
    const pred = makeLine("ab");
    const result = computeHorizontalRegionMetrics([gt], [pred], 20, weights);

    expect(result.skipReason).toBeUndefined();
    expect(result.metrics?.glyphPositionCoverage).toBe(0);
    expect(result.metrics?.charDxScoreNormMean).toBe(1);
    expect(result.metrics?.compositeScore).toBeCloseTo(0.85, 6);
  });

  it("penalizes an extra predicted line", () => {
    const gt = [makeLine("ab")];
    const pred = [makeLine("ab"), makeLine("", 30)];
    const metrics = computeHorizontalRegionMetrics(gt, pred, 20, weights).metrics!;

    expect(metrics.lineCountMatch).toBe(0);
    expect(metrics.lineCountDiff).toBe(1);
    expect(metrics.lineQuadIouMin).toBe(0);
  });

  it("skips empty line collections explicitly", () => {
    const result = computeHorizontalRegionMetrics([], [], 20, weights);
    expect(result.skipReason).toBe("no_horizontal_lines");
  });
});
