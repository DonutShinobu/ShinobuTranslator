import { describe, expect, it } from "vitest";
import type { TypesetDebugRegionLog } from "../../src/types";
import { computeVerticalGlyphQuality } from "../../benchmark/typeset/src/glyph-quality";
import { tokenizeVerticalText } from "../../src/pipeline/typeset/verticalOrientation";

function makeRegion(text: string): TypesetDebugRegionLog {
  const tokens = tokenizeVerticalText(text);
  return {
    regionId: "region",
    regionIndex: 0,
    direction: "v",
    sourceText: text,
    translatedTextRaw: text,
    translatedTextUsed: text,
    translatedColumnsRaw: [],
    preferredColumns: [],
    sourceColumns: [text],
    sourceColumnLengths: [tokens.reduce((sum, token) => sum + token.sourceGlyphCount, 0)],
    singleColumnMaxLength: null,
    initialFontSize: 20,
    fittedFontSize: 20,
    sourceBox: { x: 0, y: 0, width: 40, height: 100 },
    expandedBox: { x: 0, y: 0, width: 40, height: 100 },
    offscreenWidth: 40,
    offscreenHeight: 100,
    boxPadding: 0,
    strokePadding: 0,
    columnBreakReasons: ["start"],
    columnSegmentIds: [1],
    columnSegmentSources: ["model"],
    columnBoxes: [{ x: 0, y: 0, width: 40, height: 100 }],
    columnCanvasQuads: [[
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 100 },
      { x: 0, y: 100 },
    ]],
    columnGlyphCenters: [],
    columnVerticalItems: [tokens.map((token, index) => ({
      ...token,
      x: 20,
      y: 20 + index * 20,
      advanceY: 20,
      paintedInkHeight: token.kind === "upright-glyph" ? 14 : undefined,
      uprightInkOccupancy: token.kind === "upright-glyph" ? 0.7 : undefined,
      uprightOccupancyConstrained: token.kind === "upright-glyph" ? true : undefined,
    }))],
  };
}

describe("computeVerticalGlyphQuality", () => {
  it("reports complete orientation and run coverage", () => {
    const quality = computeVerticalGlyphQuality(makeRegion("AveMujica12!?"));
    expect(quality).toEqual({
      glyphQualityCoverage: 1,
      glyphOrientationAccuracy: 1,
      runContinuityRate: 1,
      verticalItemCenterAlignment: 1,
      runSpanFidelity: 1,
      runInkOccupancy: 1,
      runTrackingCompliance: 1,
      runTrackingEmMax: 0,
      uprightInkOccupancyMax: 0,
      uprightInkOccupancyCompliance: 1,
      glyphQualityScore: 1,
    });
  });

  it("does not treat old debug logs without item data as passing", () => {
    const region = makeRegion("AveMujica");
    delete region.columnVerticalItems;
    expect(computeVerticalGlyphQuality(region).glyphQualityScore).toBe(0);
  });

  it("detects a broken sideways run", () => {
    const region = makeRegion("AveMujica");
    region.columnVerticalItems = [[]];
    const quality = computeVerticalGlyphQuality(region);
    expect(quality.glyphOrientationAccuracy).toBe(0);
    expect(quality.runContinuityRate).toBe(0);
    expect(quality.glyphQualityScore).toBeLessThan(1);
  });

  it("scores source-aware run span, occupancy, and tracking", () => {
    const region = makeRegion("AveMujica");
    const item = region.columnVerticalItems?.[0]?.[0];
    if (!item) throw new Error("Expected source-aware run fixture item");
    item.spanMode = "source-aware";
    item.sourceTargetAdvanceY = 180;
    item.resolvedTargetAdvanceY = 180;
    item.advanceY = 90;
    item.renderedInlineSpan = 45;
    item.inkOccupancy = 0.5;
    item.inlineTracking = 10;

    const quality = computeVerticalGlyphQuality(region);
    expect(quality.runSpanFidelity).toBe(0.5);
    expect(quality.runInkOccupancy).toBe(0.5);
    expect(quality.runTrackingEmMax).toBe(0.5);
    expect(quality.runTrackingCompliance).toBeCloseTo(0.16);
    expect(quality.glyphQualityScore).toBeLessThan(1);
  });

  it("reports painted upright ink occupancy violations", () => {
    const region = makeRegion("中文");
    const item = region.columnVerticalItems?.[0]?.[0];
    if (!item) throw new Error("Expected upright fixture item");
    item.uprightInkOccupancy = 1.1;
    item.uprightOccupancyConstrained = true;

    const quality = computeVerticalGlyphQuality(region);
    expect(quality.uprightInkOccupancyMax).toBe(1.1);
    expect(quality.uprightInkOccupancyCompliance).toBeCloseTo(((0.88 / 1.1) + 1) / 2);
    expect(quality.glyphQualityScore).toBeLessThan(1);
  });
});
