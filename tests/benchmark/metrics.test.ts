import { describe, expect, it } from "vitest";
import { computeRegionMetrics } from "../../scripts/benchmark/metrics";
import type { GroundTruthColumn, ScoreWeights } from "../../scripts/benchmark/types";

const defaultWeights: ScoreWeights = {
  columnCountMatch: 0.2,
  columnIouMean: 0.3,
  fontSizeError: 0.2,
  columnDxNorm: 0.15,
  charDyNorm: 0.15,
};

function makeColumn(overrides: Partial<GroundTruthColumn> = {}): GroundTruthColumn {
  return {
    index: 0,
    text: "あいう",
    charCount: 3,
    centerX: 100,
    topY: 50,
    bottomY: 200,
    width: 30,
    height: 150,
    estimatedFontSize: 30,
    charCenters: [{ y: 75 }, { y: 125 }, { y: 175 }],
    ...overrides,
  };
}

describe("computeRegionMetrics", () => {
  describe("column count", () => {
    it("returns 1 when column counts match", () => {
      const gt = [makeColumn()];
      const pred = [makeColumn()];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      expect(result.columnCountMatch).toBe(1);
      expect(result.columnCountDiff).toBe(0);
    });

    it("returns 0 when column counts differ", () => {
      const gt = [makeColumn(), makeColumn({ index: 1, centerX: 70 })];
      const pred = [makeColumn()];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      expect(result.columnCountMatch).toBe(0);
      expect(result.columnCountDiff).toBe(-1);
    });
  });

  describe("column IoU", () => {
    it("returns 1.0 for identical columns", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 30, defaultWeights);
      expect(result.columnIouMean).toBeCloseTo(1.0, 4);
      expect(result.columnIouMin).toBeCloseTo(1.0, 4);
    });

    it("returns 0 for non-overlapping columns", () => {
      const gt = makeColumn({ centerX: 100, topY: 0, bottomY: 100, width: 30, height: 100 });
      const pred = makeColumn({ centerX: 300, topY: 0, bottomY: 100, width: 30, height: 100 });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      expect(result.columnIouMean).toBe(0);
    });

    it("returns IoU=0 for unpaired extra columns", () => {
      const gt = [makeColumn()];
      const pred = [makeColumn(), makeColumn({ index: 1, centerX: 70 })];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      expect(result.columnIouMin).toBe(0);
    });
  });

  describe("font size", () => {
    it("returns 0 error when font sizes match", () => {
      const gt = [makeColumn({ estimatedFontSize: 30 })];
      const pred = [makeColumn()];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      expect(result.fontSizeError).toBeCloseTo(0, 4);
      expect(result.fontSizeRatio).toBeCloseTo(1, 4);
    });

    it("computes relative error correctly", () => {
      const gt = [makeColumn({ estimatedFontSize: 40 })];
      const pred = [makeColumn()];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      expect(result.fontSizeError).toBeCloseTo(0.25, 4);
      expect(result.fontSizeRatio).toBeCloseTo(0.75, 4);
    });

    it("uses median of GT font sizes", () => {
      const gt = [
        makeColumn({ index: 0, estimatedFontSize: 20 }),
        makeColumn({ index: 1, estimatedFontSize: 30 }),
        makeColumn({ index: 2, estimatedFontSize: 100 }),
      ];
      const pred = [
        makeColumn({ index: 0 }),
        makeColumn({ index: 1 }),
        makeColumn({ index: 2 }),
      ];
      const result = computeRegionMetrics(gt, pred, 30, defaultWeights);
      // median of [20, 30, 100] = 30, predFont = 30
      expect(result.fontSizeError).toBeCloseTo(0, 4);
    });
  });

  describe("column horizontal offset", () => {
    it("returns 0 for aligned columns", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 30, defaultWeights);
      expect(result.columnDxNormMean).toBeCloseTo(0, 4);
      expect(result.columnDxNormMax).toBeCloseTo(0, 4);
    });

    it("normalizes offset by GT column width", () => {
      const gt = makeColumn({ centerX: 100, width: 30 });
      const pred = makeColumn({ centerX: 115, width: 30 });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      // |115 - 100| / 30 = 0.5
      expect(result.columnDxNormMean).toBeCloseTo(0.5, 4);
    });
  });

  describe("column vertical range", () => {
    it("returns 0 offsets for identical columns", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 30, defaultWeights);
      expect(result.dTopNormMean).toBeCloseTo(0, 4);
      expect(result.dBottomNormMean).toBeCloseTo(0, 4);
      expect(result.heightRatioMean).toBeCloseTo(1, 4);
    });

    it("computes normalized vertical offsets", () => {
      const gt = makeColumn({ topY: 50, bottomY: 200, height: 150 });
      const pred = makeColumn({ topY: 65, bottomY: 215, height: 150 });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      // dTop = (65-50)/150 = 0.1
      expect(result.dTopNormMean).toBeCloseTo(0.1, 4);
      // dBottom = (215-200)/150 = 0.1
      expect(result.dBottomNormMean).toBeCloseTo(0.1, 4);
    });
  });

  describe("per-char Y offset", () => {
    it("returns 0 for identical char positions", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 30, defaultWeights);
      expect(result.charDyNormMean).toBeCloseTo(0, 4);
      expect(result.charDyNormMax).toBeCloseTo(0, 4);
    });

    it("normalizes by predicted font size", () => {
      const gt = makeColumn({ charCenters: [{ y: 75 }, { y: 125 }, { y: 175 }] });
      const pred = makeColumn({ charCenters: [{ y: 80 }, { y: 135 }, { y: 175 }] });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      // deltas: |5|/30=0.167, |10|/30=0.333, |0|/30=0
      expect(result.charDyNormMean).toBeCloseTo((5 / 30 + 10 / 30 + 0) / 3, 4);
      expect(result.charDyNormMax).toBeCloseTo(10 / 30, 4);
    });

    it("handles mismatched char counts with proportional alignment", () => {
      const gt = makeColumn({
        charCenters: [{ y: 50 }, { y: 100 }, { y: 150 }, { y: 200 }],
      });
      const pred = makeColumn({
        charCenters: [{ y: 50 }, { y: 150 }],
      });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      // gt has 4 chars, pred has 2
      // j=0: predIdx=round(0*2/4)=0, dy=|50-50|=0
      // j=1: predIdx=round(1*2/4)=round(0.5)=1, dy=|150-100|=50 → 50/30
      // j=2: predIdx=round(2*2/4)=1, dy=|150-150|=0
      // j=3: predIdx=round(3*2/4)=round(1.5)=2 → >= predLen(2), skip
      // mean of [0, 50/30, 0] = (50/30)/3
      expect(result.charDyNormMean).toBeCloseTo((50 / 30) / 3, 4);
    });
  });

  describe("composite score", () => {
    it("returns 1.0 for perfect match", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 30, defaultWeights);
      expect(result.compositeScore).toBeCloseTo(1.0, 4);
    });

    it("applies weights correctly", () => {
      const gt = makeColumn({ estimatedFontSize: 30 });
      const pred = makeColumn();
      // All identical except we test with different predFontSize
      const result = computeRegionMetrics([gt], [pred], 60, defaultWeights);
      // fontSizeError = |60-30|/30 = 1.0, clamped to 1
      // font contribution = 0.2 * (1 - 1) = 0
      // everything else perfect: 0.2*1 + 0.3*1 + 0 + 0.15*1 + 0.15*1 = 0.8
      expect(result.compositeScore).toBeCloseTo(0.8, 4);
    });
  });

  describe("edge cases", () => {
    it("handles empty columns", () => {
      const result = computeRegionMetrics([], [], 30, defaultWeights);
      expect(result.columnCountMatch).toBe(1);
      expect(result.columnIouMean).toBe(0);
      expect(result.compositeScore).toBeGreaterThanOrEqual(0);
    });

    it("handles zero-width GT column without NaN", () => {
      const gt = makeColumn({ width: 0 });
      const pred = makeColumn({ centerX: 110 });
      const result = computeRegionMetrics([gt], [pred], 30, defaultWeights);
      expect(Number.isNaN(result.columnDxNormMean)).toBe(false);
    });

    it("handles zero predFontSize without NaN", () => {
      const col = makeColumn();
      const result = computeRegionMetrics([col], [col], 0, defaultWeights);
      expect(Number.isNaN(result.charDyNormMean)).toBe(false);
    });
  });
});