import { describe, it, expect } from "vitest";
import type { TextRegion } from "../../../src/types";
import {
  clampNumber,
  resolveInitialFontSize,
  metricAbs,
  computeVerticalTotalWidth,
  strokeWidth,
  resolveOffscreenGuardPadding,
  resolveVerticalStartY,
  resolveAlignment,
  resolveBoxPadding,
  resolveVerticalContentHeight,
  hasMinorOverflowWrap,
} from "../../../src/pipeline/typeset/fontFit";
import type { VerticalCellMetrics, VerticalLayoutResult, VColumn } from "../../../src/pipeline/typeset/fontFit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "test-region",
    box: { x: 0, y: 0, width: 60, height: 60 },
    sourceText: "test",
    translatedText: "test",
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<VerticalCellMetrics> = {}): VerticalCellMetrics {
  return {
    colWidth: 20,
    defaultAdvanceY: 20,
    colSpacing: 5,
    ...overrides,
  };
}

function makeVColumn(glyphCount: number, advanceY: number): VColumn {
  const glyphs = Array.from({ length: glyphCount }, (_, i) => ({
    ch: String.fromCharCode(0x3042 + i), // hiragana characters
    advanceY,
  }));
  return { glyphs, height: glyphCount * advanceY };
}

function makeLayout(overrides: Partial<VerticalLayoutResult> = {}): VerticalLayoutResult {
  return {
    columns: [],
    columnBreakReasons: [],
    columnSegmentIds: [],
    columnSegmentSources: [],
    metrics: makeMetrics(),
    requiredContentWidth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clampNumber
// ---------------------------------------------------------------------------

describe("clampNumber", () => {
  it("returns value when within range", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
  });

  it("returns min when value is below range", () => {
    expect(clampNumber(-1, 0, 10)).toBe(0);
  });

  it("returns max when value is above range", () => {
    expect(clampNumber(15, 0, 10)).toBe(10);
  });

  it("returns value at exact boundaries", () => {
    expect(clampNumber(0, 0, 10)).toBe(0);
    expect(clampNumber(10, 0, 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialFontSize
// ---------------------------------------------------------------------------

describe("resolveInitialFontSize", () => {
  it("prefers region.fontSize when set and positive", () => {
    const region = makeRegion({ fontSize: 20, box: { x: 0, y: 0, width: 60, height: 60 } });
    // fontSize=20, max(box.width, box.height)*0.8 = 60*0.8 = 48
    // clamp: max(10, min(20, round(48))) = 20
    expect(resolveInitialFontSize(region)).toBe(20);
  });

  it("uses box.height/3 heuristic when fontSize is undefined", () => {
    // box.height=60 => 60/3=20, min(48, max(14, floor(20)))=20
    // clamp: max(10, min(20, round(60*0.8=48))) = 20
    const region = makeRegion({ box: { x: 0, y: 0, width: 60, height: 60 } });
    expect(resolveInitialFontSize(region)).toBe(20);
  });

  it("uses box.height/3 heuristic when fontSize is 0", () => {
    const region = makeRegion({ fontSize: 0, box: { x: 0, y: 0, width: 60, height: 60 } });
    // fontSize=0 => not >0, so heuristic: 60/3=20
    expect(resolveInitialFontSize(region)).toBe(20);
  });

  it("clamps heuristic result to 14 minimum", () => {
    // box.height=30 => 30/3=10, max(14, floor(10))=14
    // clamp: max(10, min(14, round(30*0.8=24))) = 14
    const region = makeRegion({ box: { x: 0, y: 0, width: 30, height: 30 } });
    expect(resolveInitialFontSize(region)).toBe(14);
  });

  it("clamps heuristic result to 48 maximum", () => {
    // box.height=200 => 200/3=66, min(48, max(14, 66))=48
    // clamp: max(10, min(48, round(200*0.8=160))) = 48
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 200 } });
    expect(resolveInitialFontSize(region)).toBe(48);
  });

  it("clamps fontSize to max(box_dim * 0.8)", () => {
    // fontSize=50, max(width, height)*0.8 = 30*0.8 = 24
    // clamp: max(10, min(50, round(24))) = 24
    const region = makeRegion({ fontSize: 50, box: { x: 0, y: 0, width: 30, height: 30 } });
    expect(resolveInitialFontSize(region)).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// metricAbs
// ---------------------------------------------------------------------------

describe("metricAbs", () => {
  it("returns absolute value of negative number", () => {
    expect(metricAbs(-5)).toBe(5);
  });

  it("returns absolute value of positive number", () => {
    expect(metricAbs(5)).toBe(5);
  });

  it("returns 0 for NaN", () => {
    expect(metricAbs(Number.NaN)).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(metricAbs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(metricAbs(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("returns 0 for -Infinity", () => {
    expect(metricAbs(-Infinity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeVerticalTotalWidth
// ---------------------------------------------------------------------------

describe("computeVerticalTotalWidth", () => {
  it("returns 0 for 0 columns", () => {
    expect(computeVerticalTotalWidth(0, makeMetrics())).toBe(0);
  });

  it("returns colWidth for 1 column", () => {
    expect(computeVerticalTotalWidth(1, makeMetrics({ colWidth: 20, colSpacing: 5 }))).toBe(20);
  });

  it("returns correct width for 2 columns", () => {
    // 2 * 20 + 1 * 5 = 45
    expect(computeVerticalTotalWidth(2, makeMetrics({ colWidth: 20, colSpacing: 5 }))).toBe(45);
  });

  it("returns correct width for 3 columns", () => {
    // 3 * 20 + 2 * 5 = 70
    expect(computeVerticalTotalWidth(3, makeMetrics({ colWidth: 20, colSpacing: 5 }))).toBe(70);
  });

  it("handles zero colSpacing", () => {
    expect(computeVerticalTotalWidth(3, makeMetrics({ colWidth: 20, colSpacing: 0 }))).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// strokeWidth
// ---------------------------------------------------------------------------

describe("strokeWidth", () => {
  it("returns minimum 1 for small fontSize", () => {
    // fontSize=20 => round(20*0.07)=round(1.4)=1, max(1,1)=1
    expect(strokeWidth(20)).toBe(1);
  });

  it("returns 7% of fontSize for large fontSize", () => {
    // fontSize=100 => round(100*0.07)=round(7)=7, max(1,7)=7
    expect(strokeWidth(100)).toBe(7);
  });

  it("returns 1 for very small fontSize", () => {
    // fontSize=10 => round(0.7)=1, max(1,1)=1
    expect(strokeWidth(10)).toBe(1);
  });

  it("returns 1 for fontSize=0", () => {
    expect(strokeWidth(0)).toBe(1);
  });

  it("rounds 0.07 * fontSize", () => {
    // fontSize=50 => round(3.5)=4 (rounds to nearest even in some impls, or 3/4)
    // Math.round(3.5) = 4 in JavaScript
    expect(strokeWidth(50)).toBe(Math.max(1, Math.round(50 * 0.07)));
  });
});

// ---------------------------------------------------------------------------
// resolveOffscreenGuardPadding
// ---------------------------------------------------------------------------

describe("resolveOffscreenGuardPadding", () => {
  it("returns minOffscreenGuardPaddingPx for small fontSize", () => {
    // fontSize=10 => max(8, round(10*0.35)) = max(8, round(3.5)) = max(8, 4) = 8
    expect(resolveOffscreenGuardPadding(10)).toBe(8);
  });

  it("returns fontSize*0.35 for large fontSize", () => {
    // fontSize=40 => max(8, round(40*0.35)) = max(8, round(14)) = max(8, 14) = 14
    expect(resolveOffscreenGuardPadding(40)).toBe(14);
  });

  it("returns 8 for fontSize=0", () => {
    // max(8, round(0)) = max(8, 0) = 8
    expect(resolveOffscreenGuardPadding(0)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalStartY
// ---------------------------------------------------------------------------

describe("resolveVerticalStartY", () => {
  it("returns centered Y for center alignment", () => {
    // alignment="center", contentHeight=100, columnHeight=50, padding=10
    // padding + (contentHeight - columnHeight) / 2 = 10 + 25 = 35
    expect(resolveVerticalStartY(100, 50, "center", 10)).toBe(35);
  });

  it("returns bottom-aligned Y for right alignment", () => {
    // alignment="right", contentHeight=100, columnHeight=50, padding=10
    // padding + contentHeight - columnHeight = 10 + 50 = 60
    expect(resolveVerticalStartY(100, 50, "right", 10)).toBe(60);
  });

  it("returns padding for left alignment", () => {
    // alignment="left", contentHeight=100, columnHeight=50, padding=10
    // just padding = 10
    expect(resolveVerticalStartY(100, 50, "left", 10)).toBe(10);
  });

  it("returns padding when contentHeight equals columnHeight", () => {
    // center alignment with equal heights: padding + 0/2 = padding
    expect(resolveVerticalStartY(50, 50, "center", 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveAlignment
// ---------------------------------------------------------------------------

describe("resolveAlignment", () => {
  it("returns center for single line", () => {
    const region = makeRegion({ direction: "v" });
    expect(resolveAlignment(region, 1)).toBe("center");
  });

  it("returns left for vertical direction with multiple lines", () => {
    const region = makeRegion({ direction: "v" });
    expect(resolveAlignment(region, 2)).toBe("left");
  });

  it("returns center for horizontal direction with multiple lines", () => {
    const region = makeRegion({ direction: "h" });
    expect(resolveAlignment(region, 2)).toBe("center");
  });

  it("returns center when direction is undefined with multiple lines", () => {
    // direction defaults to "h" behavior — resolveAlignment returns "center" for non-vertical
    const region = makeRegion();
    expect(resolveAlignment(region, 3)).toBe("center");
  });
});

// ---------------------------------------------------------------------------
// resolveBoxPadding
// ---------------------------------------------------------------------------

describe("resolveBoxPadding", () => {
  it("returns 0 for any region", () => {
    const region = makeRegion();
    expect(resolveBoxPadding(region)).toBe(0);
  });

  it("returns 0 regardless of region properties", () => {
    const region = makeRegion({ direction: "v", fontSize: 30 });
    expect(resolveBoxPadding(region)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalContentHeight
// ---------------------------------------------------------------------------

describe("resolveVerticalContentHeight", () => {
  it("adds dynamic extra to contentHeight", () => {
    // contentHeight=100, fontSize=20
    // dynamicRatio = clamp(0.007 + 20*0.0, 0, 0.24) = 0.007
    // dynamicMax = max(14, round(20*1.6)) = max(14, 32) = 32
    // extra = clamp(round(100*0.007), 0, 32) = clamp(1, 0, 32) = 1
    // result = 100 + 1 = 101
    expect(resolveVerticalContentHeight(100, 20)).toBe(101);
  });

  it("returns at least contentHeight + 0 for zero contentHeight", () => {
    // contentHeight=0, fontSize=20
    // dynamicRatio = 0.007
    // dynamicMax = 32
    // extra = clamp(round(0*0.007), 0, 32) = clamp(0, 0, 32) = 0
    // result = 0 + 0 = 0
    expect(resolveVerticalContentHeight(0, 20)).toBe(0);
  });

  it("clamps dynamic extra to dynamicMax", () => {
    // Very large contentHeight with small fontSize
    // contentHeight=10000, fontSize=20
    // dynamicRatio = 0.007
    // extra = clamp(round(10000*0.007), 0, 32) = clamp(70, 0, 32) = 32
    // result = 10000 + 32 = 10032
    expect(resolveVerticalContentHeight(10000, 20)).toBe(10032);
  });
});

// ---------------------------------------------------------------------------
// hasMinorOverflowWrap
// ---------------------------------------------------------------------------

describe("hasMinorOverflowWrap", () => {
  it("returns false for layout with less than 2 columns", () => {
    const layout = makeLayout({
      columns: [makeVColumn(3, 20)],
      columnBreakReasons: ["start"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(false);
  });

  it("returns false when last column break reason is 'model'", () => {
    const layout = makeLayout({
      columns: [makeVColumn(3, 20), makeVColumn(3, 20)],
      columnBreakReasons: ["start", "model"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(false);
  });

  it("returns false when last column break reason is 'start'", () => {
    const layout = makeLayout({
      columns: [makeVColumn(3, 20), makeVColumn(3, 20)],
      columnBreakReasons: ["start", "start"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(false);
  });

  it("returns true when last column has wrap reason and 1-2 glyphs", () => {
    const layout = makeLayout({
      columns: [makeVColumn(5, 20), makeVColumn(1, 20)],
      columnBreakReasons: ["start", "wrap"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(true);
  });

  it("returns true when last column has 'both' reason and 2 glyphs", () => {
    const layout = makeLayout({
      columns: [makeVColumn(5, 20), makeVColumn(2, 20)],
      columnBreakReasons: ["start", "both"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(true);
  });

  it("returns false when last column has wrap reason but more than 2 glyphs", () => {
    const layout = makeLayout({
      columns: [makeVColumn(5, 20), makeVColumn(3, 20)],
      columnBreakReasons: ["start", "wrap"],
    });
    // minorOverflowMaxGlyphCount = 2, so 3 glyphs is not minor
    expect(hasMinorOverflowWrap(layout)).toBe(false);
  });

  it("returns false when last column has 0 glyphs", () => {
    const layout = makeLayout({
      columns: [makeVColumn(5, 20), makeVColumn(0, 20)],
      columnBreakReasons: ["start", "wrap"],
    });
    expect(hasMinorOverflowWrap(layout)).toBe(false);
  });
});