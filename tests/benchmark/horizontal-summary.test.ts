import { describe, expect, it } from "vitest";
import { computeHorizontalRegionMetrics } from "../../benchmark/typeset/src/horizontal-metrics";
import { summarizeHorizontalMetrics } from "../../benchmark/typeset/src/horizontal-summary";
import type {
  GroundTruthColumn,
  HorizontalRegionMetrics,
  HorizontalScoreWeights,
} from "../../benchmark/typeset/src/types";

const weights: HorizontalScoreWeights = {
  lineCountMatch: 0.2,
  lineQuadIouMean: 0.3,
  fontSizeError: 0.2,
  lineDyNorm: 0.15,
  charDxNorm: 0.15,
};

function line(centers: Array<{ x: number; y: number }>): GroundTruthColumn {
  return {
    index: 0,
    text: "abc",
    charCount: 3,
    centerX: 30,
    topY: 0,
    bottomY: 20,
    width: 60,
    height: 20,
    estimatedFontSize: 20,
    charCenters: centers,
    quad: [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 0, y: 20 },
    ],
  };
}

describe("summarizeHorizontalMetrics", () => {
  it("aggregates glyph distances globally rather than averaging region percentiles", () => {
    const gt = line([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 50, y: 10 }]);
    const pred = line([{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 90, y: 10 }]);
    const computation = computeHorizontalRegionMetrics([gt], [pred], 20, weights);
    const region: HorizontalRegionMetrics = {
      regionId: "r1",
      direction: "h",
      skipped: false,
      ...computation.metrics!,
    };
    const diagnostics = computation.glyphDiagnostics.map((item) => ({
      ...item,
      imageFile: "image.png",
      regionId: "r1",
    }));

    const summary = summarizeHorizontalMetrics([region], 0, diagnostics);

    expect(summary.matchedGlyphCount).toBe(3);
    expect(summary.positionedGlyphCount).toBe(3);
    expect(summary.charDistanceNormMean).toBeCloseTo((0 + 0.5 + 2) / 3, 6);
    expect(summary.charDistanceNormMedian).toBeCloseTo(0.5, 6);
    expect(summary.charDistanceOverOneEmRate).toBeCloseTo(1 / 3, 6);
    expect(summary.charDxScoreNormMean).toBeCloseTo((0 + 0.5 + 2) / 3, 6);
  });
});
