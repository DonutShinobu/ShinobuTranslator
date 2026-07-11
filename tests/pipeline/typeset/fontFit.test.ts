import { describe, it, expect } from "vitest";
import type { TextRegion } from "../../../src/types";
import type { PipelineRenderingContext } from "../../../src/runtime/platform";
import {
  clampNumber,
  resolveInitialFontSize,
  metricAbs,
  computeVerticalTotalWidth,
  resolveVerticalColumnPositions,
  resolveVerticalSourceColumnAnchor,
  resolveVerticalSourceColumnStartOffsets,
  resolveVerticalSourceGeometryProfile,
  strokeWidth,
  resolveOffscreenGuardPadding,
  resolveVerticalStartY,
  buildVerticalDebugColumnBoxes,
  resolveAlignment,
  resolveBoxPadding,
  resolveVerticalContentHeight,
  hasMinorOverflowWrap,
  resolveGlyphVerticalAdvance,
  resolveVerticalTokenMetrics,
  sourceGeometryActualBoxScale,
  estimateVerticalPreferredProfile,
  minVerticalAdvanceScale,
} from "../../../src/pipeline/typeset/fontFit";
import type {
  VerticalCellMetrics,
  VerticalLayoutResult,
  VerticalSourceGeometryProfile,
  VColumn,
} from "../../../src/pipeline/typeset/fontFit";
import { tokenizeVerticalText } from "../../../src/pipeline/typeset/verticalOrientation";

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
  const glyphs = Array.from({ length: glyphCount }, (_, i) => {
    const sourceText = String.fromCharCode(0x3042 + i);
    const token = tokenizeVerticalText(sourceText)[0];
    if (!token) throw new Error("Expected one vertical token");
    return {
      ...token,
      ch: token.displayText,
      advanceY,
      renderInlineScale: 1,
      renderCrossScale: 1,
      renderOffsetX: 0,
      renderOffsetY: 0,
      inkWidth: advanceY,
      inkHeight: advanceY,
      boundaryGap: 0,
    };
  });
  return { glyphs, height: glyphCount * advanceY };
}

function makeVerticalGlyph(sourceText: string, advanceY: number): VColumn["glyphs"][number] {
  const token = tokenizeVerticalText(sourceText)[0];
  if (!token) throw new Error("Expected one vertical token");
  return {
    ...token,
    ch: token.displayText,
    advanceY,
    renderInlineScale: 1,
    renderCrossScale: 1,
    renderOffsetX: 0,
    renderOffsetY: 0,
    inkWidth: advanceY,
    inkHeight: advanceY,
    boundaryGap: 0,
  };
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

describe("resolveVerticalTokenMetrics", () => {
  const ctx = {
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    measureText: (text: string) => {
      if (text === "国") {
        return {
          width: 20,
          actualBoundingBoxLeft: 10,
          actualBoundingBoxRight: 10,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          fontBoundingBoxAscent: 16,
          fontBoundingBoxDescent: 4,
        };
      }
      if (text === "AveMujica") {
        return {
          width: 60,
          actualBoundingBoxLeft: 35,
          actualBoundingBoxRight: 25,
          actualBoundingBoxAscent: 6,
          actualBoundingBoxDescent: 4,
          fontBoundingBoxAscent: 16,
          fontBoundingBoxDescent: 4,
        };
      }
      return {
        width: 18,
        actualBoundingBoxLeft: 9,
        actualBoundingBoxRight: 9,
        actualBoundingBoxAscent: 4,
        actualBoundingBoxDescent: 4,
        fontBoundingBoxAscent: 16,
        fontBoundingBoxDescent: 4,
      };
    },
  } as unknown as CanvasRenderingContext2D;

  it("derives Latin optical size, boundary gap, and center offset from ink bounds", () => {
    const token = tokenizeVerticalText("AveMujica")[0];
    const metrics = resolveVerticalTokenMetrics(ctx, token, 20, 20);

    expect(metrics).toMatchObject({
      advanceY: 82,
      renderInlineScale: 1.2,
      renderCrossScale: 1.2,
      renderOffsetX: 5,
      renderOffsetY: 1,
      inkWidth: 60,
      inkHeight: 10,
      boundaryGap: 5,
    });
  });

  it("keeps a rotated prolonged mark on the standard glyph path", () => {
    const token = tokenizeVerticalText("ー")[0];
    const metrics = resolveVerticalTokenMetrics(ctx, token, 20, 20);

    expect(metrics).toMatchObject({
      advanceY: 20,
      renderInlineScale: 1,
      renderCrossScale: 1,
      boundaryGap: 0,
    });
  });

  it("does not squeeze a Latin word to the source per-character advance", () => {
    const token = tokenizeVerticalText("AveMujica")[0];
    const metrics = resolveVerticalTokenMetrics(ctx, token, 20, 20, 0.7);

    expect(metrics).toMatchObject({
      advanceY: 76,
      renderInlineScale: 1.2,
      renderCrossScale: 1.2,
      boundaryGap: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveGlyphVerticalAdvance
// ---------------------------------------------------------------------------

describe("resolveGlyphVerticalAdvance", () => {
  const ctx = {
    measureText: () => ({
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 10,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 12,
    }),
  };

  it("keeps the scaled actual box as the default advance lower bound", () => {
    expect(resolveGlyphVerticalAdvance(ctx as never, "A", 20, 20, 0.9)).toBe(22);
  });

  it("allows source geometry to use a tighter actual box lower bound", () => {
    expect(resolveGlyphVerticalAdvance(ctx as never, "A", 20, 20, 0.9, sourceGeometryActualBoxScale)).toBe(18);
  });

  it("can use default advance as the source-geometry step base", () => {
    const wideFontBoxCtx = {
      measureText: () => ({
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 12,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 8,
      }),
    };

    expect(resolveGlyphVerticalAdvance(wideFontBoxCtx as never, "A", 20, 20, 1)).toBe(24);
    expect(
      resolveGlyphVerticalAdvance(wideFontBoxCtx as never, "A", 20, 20, 1, sourceGeometryActualBoxScale, true),
    ).toBe(20);
  });

  it("biases fractional source-geometry advance to avoid per-glyph accumulation overflow", () => {
    const ctx = {
      measureText: () => ({
        fontBoundingBoxAscent: 0,
        fontBoundingBoxDescent: 0,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
      }),
    };

    expect(resolveGlyphVerticalAdvance(ctx as never, "A", 62, 90, 0.6955555555555556)).toBe(63);
    expect(
      resolveGlyphVerticalAdvance(ctx as never, "A", 62, 90, 0.6955555555555556, sourceGeometryActualBoxScale, true),
    ).toBe(62);
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

  it("supports limited overlapping columns from source geometry", () => {
    expect(computeVerticalTotalWidth(3, makeMetrics({ colWidth: 20, colSpacing: -4 }))).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalColumnPositions
// ---------------------------------------------------------------------------

describe("resolveVerticalColumnPositions", () => {
  it("centers columns by default in right-to-left order", () => {
    const positions = resolveVerticalColumnPositions(
      3,
      100,
      makeMetrics({ colWidth: 20, colSpacing: 5 }),
      10,
    );

    expect(positions.totalWidth).toBe(70);
    expect(positions.groupCenterX).toBe(60);
    expect(positions.centers).toEqual([85, 60, 35]);
  });

  it("uses an explicit content-space group center anchor", () => {
    const positions = resolveVerticalColumnPositions(
      2,
      100,
      makeMetrics({ colWidth: 20, colSpacing: 5 }),
      10,
      { contentCenterX: 40 },
    );

    expect(positions.groupCenterX).toBe(50);
    expect(positions.centers).toEqual([62.5, 37.5]);
  });

  it("clamps anchored columns inside content bounds when possible", () => {
    const positions = resolveVerticalColumnPositions(
      3,
      100,
      makeMetrics({ colWidth: 20, colSpacing: 5 }),
      10,
      { contentCenterX: 5 },
    );

    expect(positions.groupCenterX).toBe(45);
    expect(positions.centers).toEqual([70, 45, 20]);
  });

  it("keeps right-to-left center pitch when spacing is negative", () => {
    const positions = resolveVerticalColumnPositions(
      3,
      100,
      makeMetrics({ colWidth: 20, colSpacing: -4 }),
      10,
    );

    expect(positions.totalWidth).toBe(52);
    expect(positions.centers).toEqual([76, 60, 44]);
  });

});

// ---------------------------------------------------------------------------
// Source geometry profile
// ---------------------------------------------------------------------------

describe("resolveVerticalSourceGeometryProfile", () => {
  it("extracts source pitch and content-space anchor from original columns", () => {
    const region = makeRegion({
      box: { x: 30, y: 20, width: 90, height: 100 },
      sourceText: "ABCD\nEFG",
      sourceLineGeometries: [
        {
          text: "ABCD",
          direction: "v",
          box: { x: 80, y: 25, width: 20, height: 80 },
          centerX: 90,
          centerY: 65,
          width: 20,
          height: 80,
        },
        {
          text: "EFG",
          direction: "v",
          box: { x: 50, y: 25, width: 20, height: 60 },
          centerX: 60,
          centerY: 55,
          width: 20,
          height: 60,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);
    expect(profile).toMatchObject({
      columnCount: 2,
      groupCenterX: 75,
      sourceFontSize: 20,
      sourcePitch: 30,
      medianPitch: 30,
      medianGap: 10,
      medianWidth: 20,
      medianHeight: 70,
      medianAdvance: 20,
      perColumnAdvance: [20, 20],
      perColumnTopY: [25, 25],
    });

    expect(resolveVerticalSourceColumnAnchor(region, 5, profile)).toEqual({ contentCenterX: 40 });
  });

  it("maps staggered source tops into content-space offsets", () => {
    const region = makeRegion({
      box: { x: 100, y: 200, width: 120, height: 300 },
      sourceText: "right\nleft",
      sourceLineGeometries: [
        {
          text: "right",
          direction: "v",
          box: { x: 180, y: 250, width: 20, height: 100 },
          centerX: 190,
          centerY: 300,
          width: 20,
          height: 100,
        },
        {
          text: "left",
          direction: "v",
          box: { x: 130, y: 290, width: 20, height: 80 },
          centerX: 140,
          centerY: 330,
          width: 20,
          height: 80,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.perColumnTopY).toEqual([250, 290]);
    expect(resolveVerticalSourceColumnStartOffsets(region, 10, 2, profile)).toEqual([40, 80]);
  });

  it("does not apply source top offsets to single or rotated column layouts", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 100, height: 200 },
      quad: [
        { x: 0, y: 0 },
        { x: 100, y: 10 },
        { x: 80, y: 210 },
        { x: -20, y: 200 },
      ],
      sourceText: "right\nleft",
      sourceLineGeometries: [
        {
          text: "right",
          direction: "v",
          box: { x: 60, y: 20, width: 20, height: 100 },
          centerX: 70,
          centerY: 70,
          width: 20,
          height: 100,
        },
        {
          text: "left",
          direction: "v",
          box: { x: 20, y: 40, width: 20, height: 100 },
          centerX: 30,
          centerY: 90,
          width: 20,
          height: 100,
        },
      ],
    });
    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(resolveVerticalSourceColumnStartOffsets(region, 0, 1, profile)).toBeUndefined();
    expect(resolveVerticalSourceColumnStartOffsets(region, 0, 2, profile)).toBeUndefined();
  });

  it("keeps pitch targets in spatial order and advance targets in source order", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 160, height: 160 },
      sourceText: "short\nlonger",
      sourceLineGeometries: [
        {
          text: "short",
          direction: "v",
          box: { x: 100, y: 0, width: 20, height: 100 },
          centerX: 110,
          centerY: 50,
          width: 20,
          height: 100,
        },
        {
          text: "longer",
          direction: "v",
          box: { x: 20, y: 0, width: 20, height: 180 },
          centerX: 30,
          centerY: 90,
          width: 20,
          height: 180,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.medianPitch).toBe(80);
    expect(profile?.medianAdvance).toBe(25);
    expect(profile?.perColumnAdvance).toEqual([20, 30]);
  });

  it("does not expose per-column advance when source order is not spatially monotonic", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 160, height: 160 },
      sourceText: "short\nlonger",
      sourceLineGeometries: [
        {
          text: "short",
          direction: "v",
          box: { x: 20, y: 0, width: 20, height: 100 },
          centerX: 30,
          centerY: 50,
          width: 20,
          height: 100,
        },
        {
          text: "longer",
          direction: "v",
          box: { x: 100, y: 0, width: 20, height: 180 },
          centerX: 110,
          centerY: 90,
          width: 20,
          height: 180,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.medianPitch).toBe(80);
    expect(profile?.medianAdvance).toBe(25);
    expect(profile?.perColumnAdvance).toEqual([]);
  });

  it("matches source advance by text when geometry array order is not source order", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 160, height: 160 },
      sourceText: "right\nleft",
      sourceLineGeometries: [
        {
          text: "left",
          direction: "v",
          box: { x: 20, y: 0, width: 20, height: 120 },
          centerX: 30,
          centerY: 60,
          width: 20,
          height: 120,
        },
        {
          text: "right",
          direction: "v",
          box: { x: 100, y: 0, width: 20, height: 250 },
          centerX: 110,
          centerY: 125,
          width: 20,
          height: 250,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.medianPitch).toBe(80);
    expect(profile?.medianAdvance).toBe(40);
    expect(profile?.perColumnAdvance).toEqual([50, 30]);
  });

  it("does not expose per-column advance when source text cannot be matched", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 160, height: 160 },
      sourceText: "right\nleft",
      sourceLineGeometries: [
        {
          text: "other",
          direction: "v",
          box: { x: 20, y: 0, width: 20, height: 120 },
          centerX: 30,
          centerY: 60,
          width: 20,
          height: 120,
        },
        {
          text: "right",
          direction: "v",
          box: { x: 100, y: 0, width: 20, height: 250 },
          centerX: 110,
          centerY: 125,
          width: 20,
          height: 250,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.medianPitch).toBe(80);
    expect(profile?.medianAdvance).toBe(37);
    expect(profile?.perColumnAdvance).toEqual([]);
  });

  it("keeps source style estimates and clamps overlapping column pitch to one em", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 100, height: 100 },
      sourceText: "甲乙丙丁戊\n己庚辛壬癸",
      sourceLineGeometries: [
        {
          text: "甲乙丙丁戊",
          direction: "v",
          box: { x: 20, y: 0, width: 40, height: 100 },
          centerX: 40,
          centerY: 50,
          width: 40,
          height: 100,
        },
        {
          text: "己庚辛壬癸",
          direction: "v",
          box: { x: 0, y: 0, width: 40, height: 100 },
          centerX: 20,
          centerY: 50,
          width: 40,
          height: 100,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile).toBeDefined();
    expect(profile?.sourceFontSize).toBe(20);
    expect(profile?.medianAdvance).toBe(20);
    expect(profile?.medianPitch).toBe(20);
    expect(profile?.sourcePitch).toBe(20);
  });

  it("rejects profiles when source column count no longer matches layout target", () => {
    const region = makeRegion({
      sourceLineGeometries: [
        {
          text: "A",
          direction: "v",
          box: { x: 10, y: 0, width: 10, height: 20 },
          centerX: 15,
          centerY: 10,
          width: 10,
          height: 20,
        },
      ],
    });

    expect(resolveVerticalSourceGeometryProfile(region, 2)).toBeUndefined();
  });

  it("uses real glyph count for source advance instead of half-width text length", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 80, height: 118 },
      sourceText: "へぇ",
      sourceLineGeometries: [
        {
          text: "へぇ",
          direction: "v",
          box: { x: 0, y: 0, width: 80, height: 118 },
          centerX: 40,
          centerY: 59,
          width: 80,
          height: 118,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 1);
    expect(profile?.sourceFontSize).toBe(59);
    expect(profile?.perColumnAdvance).toEqual([59]);
  });

  it("uses Canvas font measurements for source font-size and advance", () => {
    const measureCtx = {
      font: "",
      measureText(text: string) {
        const fontSize = Number.parseFloat(this.font) || 100;
        if (text === "国") return { width: fontSize };
        if (!/^\p{Script=Latin}+$/u.test(text)) {
          throw new Error("竖排日文不应进入横向字体测量");
        }
        return { width: text.length * fontSize * 0.5 };
      },
    } as unknown as PipelineRenderingContext;
    const region = makeRegion({
      box: { x: 0, y: 0, width: 120, height: 450 },
      sourceText: "日本語日本語\nABCDEFGHIJ\n安心安心",
      sourceLineGeometries: [
        {
          text: "日本語日本語",
          direction: "v",
          box: { x: 80, y: 0, width: 44, height: 240 },
          centerX: 102,
          centerY: 120,
          width: 44,
          height: 240,
          fontSize: 40,
        },
        {
          text: "ABCDEFGHIJ",
          direction: "v",
          box: { x: 40, y: 0, width: 44, height: 300 },
          centerX: 62,
          centerY: 150,
          width: 44,
          height: 300,
          fontSize: 30,
        },
        {
          text: "安心安心",
          direction: "v",
          box: { x: 0, y: 0, width: 34, height: 156 },
          centerX: 17,
          centerY: 78,
          width: 34,
          height: 156,
          fontSize: 34,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 3, measureCtx, "Test Sans");

    expect(profile?.sourceFontSize).toBe(40);
    expect(profile?.medianAdvance).toBe(40);
    expect(profile?.perColumnAdvance[0]).toBeCloseTo(40);
    expect(profile?.perColumnAdvance[1]).toBeCloseTo(60);
    expect(profile?.perColumnAdvance[2]).toBeCloseTo(39);
  });

  it("ignores a one-glyph outlier when another column provides spacing evidence", () => {
    const region = makeRegion({
      box: { x: 0, y: 0, width: 100, height: 240 },
      sourceText: "N\n日本語日本語",
      sourceLineGeometries: [
        {
          text: "N",
          direction: "v",
          box: { x: 40, y: 0, width: 60, height: 240 },
          centerX: 70,
          centerY: 120,
          width: 60,
          height: 240,
        },
        {
          text: "日本語日本語",
          direction: "v",
          box: { x: 0, y: 0, width: 40, height: 240 },
          centerX: 20,
          centerY: 120,
          width: 40,
          height: 240,
        },
      ],
    });

    const profile = resolveVerticalSourceGeometryProfile(region, 2);

    expect(profile?.sourceFontSize).toBe(40);
    expect(profile?.medianAdvance).toBe(40);
    expect(profile?.perColumnAdvance).toEqual([40, 40]);
  });
});

describe("estimateVerticalPreferredProfile", () => {
  const ctx = {
    font: "",
    measureText: (text: string) => {
      const fontSize = Number.parseFloat(ctx.font) || 20;
      return {
      width: Math.max(fontSize, text.length * fontSize * 0.6),
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: fontSize,
      actualBoundingBoxAscent: fontSize * 0.8,
      actualBoundingBoxDescent: fontSize * 0.2,
      fontBoundingBoxAscent: fontSize * 0.8,
      fontBoundingBoxDescent: fontSize * 0.2,
    };
    },
  };

  function makeSourceProfile(
    overrides: Partial<VerticalSourceGeometryProfile> = {},
  ): VerticalSourceGeometryProfile {
    return {
      columnCount: 1,
      groupCenterX: 40,
      sourceFontSize: 20,
      sourcePitch: 30,
      medianPitch: null,
      medianGap: null,
      medianWidth: 20,
      medianHeight: 40,
      medianAdvance: 20,
      perColumnAdvance: [20],
      perColumnTopY: [0],
      ...overrides,
    };
  }

  it("keeps the fallback advance floor when source geometry is unavailable", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "A",
      translatedText: "A",
      originalLineCount: 1,
    });

    const withoutSource = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "A",
      80,
      5,
      20,
      "sans-serif",
      ["A"],
      80,
    );

    expect(withoutSource.advanceScale).toBe(minVerticalAdvanceScale);
  });

  it("does not derive source advance from translated length or content height", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "原文",
      translatedText: "中文",
      originalLineCount: 1,
    });
    const sourceProfile = makeSourceProfile({ medianAdvance: 24 });

    const short = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "中文",
      80,
      30,
      20,
      "sans-serif",
      ["中文"],
      80,
      sourceProfile,
    );
    const long = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "这是一段明显更长的中文译文",
      80,
      300,
      20,
      "sans-serif",
      ["这是一段明显更长的中文译文"],
      80,
      sourceProfile,
    );

    expect(short.advanceScale).toBeCloseTo(1.2);
    expect(long.advanceScale).toBeCloseTo(short.advanceScale);
    expect(short.perColumnAdvanceScale).toBeUndefined();
    expect(long.perColumnAdvanceScale).toBeUndefined();
  });

  it("uses real glyph count, not weighted text length, for vertical advance targets", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "ちょっと物憂げな",
      translatedText: "ちょっと物憂げな",
      originalLineCount: 1,
    });

    const profile = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "ちょっと物憂げな",
      120,
      160,
      20,
      "sans-serif",
      ["ちょっと物憂げな"],
      120,
    );

    expect(profile.advanceScale).toBe(1);
  });

  it("derives per-column advance scales from matched source geometry", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "AA\nBBBB",
      translatedText: "AA\nBBBB",
      originalLineCount: 2,
    });

    const profile = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "AABBBB",
      120,
      200,
      20,
      "sans-serif",
      ["AA", "BBBB"],
      120,
      makeSourceProfile({
        columnCount: 2,
        groupCenterX: 60,
        sourcePitch: 60,
        medianPitch: 60,
        medianGap: 40,
        medianHeight: 100,
        medianAdvance: 25,
        perColumnAdvance: [30, 20],
        perColumnTopY: [0, 0],
      }),
    );

    expect(profile.advanceScale).toBeCloseTo(1.25);
    expect(profile.perColumnAdvanceScale).toEqual([1.5, 1]);
  });

  it("uses the global source advance when translated columns no longer map to source columns", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "AA\nBBBB",
      translatedText: "甲乙丙丁",
      originalLineCount: 2,
    });

    const profile = estimateVerticalPreferredProfile(
      ctx as never,
      region,
      "甲乙丙丁",
      120,
      200,
      20,
      "sans-serif",
      ["甲乙", "丙丁"],
      120,
      makeSourceProfile({
        columnCount: 2,
        sourcePitch: 30,
        medianPitch: 30,
        medianGap: 10,
        medianAdvance: 25,
        perColumnAdvance: [30, 20],
        perColumnTopY: [0, 0],
      }),
    );

    expect(profile.advanceScale).toBeCloseTo(1.25);
    expect(profile.perColumnAdvanceScale).toBeUndefined();
  });

  it("scales source advance and column pitch together with the font size", () => {
    const region = makeRegion({
      direction: "v",
      sourceText: "甲\n乙",
      translatedText: "丙\n丁",
      originalLineCount: 2,
    });
    const sourceProfile = makeSourceProfile({
      columnCount: 2,
      sourcePitch: 30,
      medianPitch: 30,
      medianGap: 10,
      medianAdvance: 24,
      perColumnAdvance: [24, 24],
      perColumnTopY: [0, 0],
    });

    const fullSize = estimateVerticalPreferredProfile(
      ctx as never, region, "丙丁", 80, 100, 20, "sans-serif", ["丙", "丁"], 80, sourceProfile,
    );
    const halfSize = estimateVerticalPreferredProfile(
      ctx as never, region, "丙丁", 80, 100, 10, "sans-serif", ["丙", "丁"], 80, sourceProfile,
    );

    expect(fullSize.advanceScale).toBeCloseTo(1.2);
    expect(halfSize.advanceScale).toBeCloseTo(1.2);
    expect(fullSize.colSpacingScale).toBeCloseTo(4);
    expect(halfSize.colSpacingScale).toBeCloseTo(4);
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

  it("uses and clamps a source-derived start offset", () => {
    expect(resolveVerticalStartY(100, 40, "left", 10, 25)).toBe(35);
    expect(resolveVerticalStartY(100, 80, "left", 10, 50)).toBe(30);
  });

  it("applies independent source starts to debug column boxes", () => {
    const columns: VColumn[] = [
      { glyphs: [makeVerticalGlyph("右", 20)], height: 20 },
      { glyphs: [makeVerticalGlyph("左", 20)], height: 20 },
    ];
    const boxes = buildVerticalDebugColumnBoxes(
      columns,
      100,
      100,
      makeMetrics(),
      "left",
      10,
      undefined,
      undefined,
      undefined,
      [15, 45],
    );

    expect(boxes.map((box) => box.y)).toEqual([25, 55]);
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
