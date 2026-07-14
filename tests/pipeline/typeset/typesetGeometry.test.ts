import { describe, it, expect } from "vitest";
import type { TextRegion } from "../../../src/types";
import { computeFullVerticalTypeset } from "../../../src/pipeline/typeset/verticalLayout";
import { calcVertical, queryMaskMaxY } from "../../../src/pipeline/typeset/verticalFit";

function createMask(width: number, height: number, fillFn: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (fillFn(x, y)) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 255;
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function createScaledMockCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: "20px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    measureText: (text: string) => {
      const fontSize = Number.parseFloat(ctx.font) || 20;
      const glyphCount = Math.max(1, Array.from(text).length);
      const width = glyphCount === 1
        ? fontSize
        : glyphCount * fontSize * 0.6;
      return {
        width,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        fontBoundingBoxAscent: fontSize * 0.8,
        fontBoundingBoxDescent: fontSize * 0.2,
      };
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function createSourceStyledRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "source-style",
    box: { x: 0, y: 0, width: 40, height: 100 },
    direction: "v",
    fontSize: 60,
    originalLineCount: 1,
    sourceText: "日日日日日",
    translatedText: "中文",
    translatedColumns: ["中文"],
    sourceLineGeometries: [
      {
        text: "日日日日日",
        direction: "v",
        box: { x: 10, y: 0, width: 20, height: 100 },
        centerX: 20,
        centerY: 50,
        width: 20,
        height: 100,
        fontSize: 20,
      },
    ],
    ...overrides,
  };
}

describe("queryMaskMaxY", () => {
  it("returns yStart when first row is already outside mask", () => {
    const mask = createMask(100, 100, () => false);
    expect(queryMaskMaxY(mask, 10, 20, 50)).toBe(50);
  });

  it("returns mask bottom when entire column is inside mask", () => {
    const mask = createMask(100, 100, () => true);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(99);
  });

  it("stops at the first row where all pixels are outside", () => {
    const mask = createMask(100, 100, (_x, y) => y < 60);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(59);
  });

  it("handles rounded bubble shape — narrower columns stop earlier", () => {
    const mask = createMask(100, 100, (x, y) => {
      return Math.hypot(x - 50, y - 50) < 40;
    });
    const centerMaxY = queryMaskMaxY(mask, 45, 55, 20);
    const edgeMaxY = queryMaskMaxY(mask, 80, 90, 20);
    expect(centerMaxY).toBeGreaterThan(edgeMaxY);
  });

  it("clamps xStart/xEnd to mask bounds", () => {
    const mask = createMask(50, 50, () => true);
    expect(queryMaskMaxY(mask, 40, 60, 0)).toBe(49);
  });
});

describe("calcVertical with perColumnMaxHeight", () => {
  function createMockCtx(): CanvasRenderingContext2D {
    return {
      font: "",
      measureText: (text: string) => ({
        width: text.length * 10,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: text.length * 5,
        actualBoundingBoxRight: text.length * 5,
        fontBoundingBoxAscent: 16,
        fontBoundingBoxDescent: 4,
      }),
    } as unknown as CanvasRenderingContext2D;
  }

  it("uses uniform maxHeight when perColumnMaxHeight not provided", () => {
    const ctx = createMockCtx();
    const columns = calcVertical(ctx, "あいうえお", 50, 20, 20, 1);
    expect(columns.length).toBeGreaterThanOrEqual(2);
  });

  it("allows first column to be taller than subsequent columns", () => {
    const ctx = createMockCtx();
    const perColMax = (ci: number) => ci === 0 ? 80 : 40;
    const columns = calcVertical(ctx, "あいうえお", 40, 20, 20, 1, perColMax);
    if (columns.length >= 2) {
      expect(columns[0].glyphs.length).toBeGreaterThanOrEqual(columns[1].glyphs.length);
    }
  });

  it("keeps trailing kinsoku punctuation in an over-height column", () => {
    const ctx = createMockCtx();
    const maxHeight = 140;
    const text = "你倒是说句话啊?";
    const columns = calcVertical(ctx, text, maxHeight, 20, 20, 1, () => maxHeight);

    expect(columns).toHaveLength(1);
    expect(columns[0].glyphs.map((glyph) => glyph.sourceText).join("")).toBe(text);
    expect(columns[0].height).toBeGreaterThan(maxHeight);
  });

  it("carries mixed runs and tate-chu-yoko through the column layout", () => {
    const ctx = createMockCtx();
    const columns = calcVertical(ctx, "AveMujica12!?", 500, 20, 20, 1);
    const glyphs = columns.flatMap((column) => column.glyphs);
    expect(glyphs).toMatchObject([
      {
        kind: "sideways-run",
        sourceText: "AveMujica",
        rotationDeg: 90,
        renderInlineScale: 1.2,
        renderCrossScale: 1.2,
        renderOffsetX: 0,
        renderOffsetY: 3,
        boundaryGap: 5,
      },
      { kind: "tate-chu-yoko", sourceText: "12", policy: "short-digits" },
      { kind: "tate-chu-yoko", sourceText: "!?", policy: "terminal-punctuation" },
    ]);
    expect(glyphs[0].advanceY).toBeGreaterThan(20);
  });
});

describe("computeFullVerticalTypeset source style", () => {
  it("keeps source font size and advance for a shorter translation", () => {
    const region = createSourceStyledRegion();
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.initialFontSize).toBe(20);
    expect(result.fittedFontSize).toBe(20);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].height).toBe(40);
    expect(result.columns[0].glyphs.map((glyph) => glyph.advanceY)).toEqual([20, 20]);
    expect(result.expandedRegion.box).toEqual(region.box);
    expect(result.layoutDiagnostics).toMatchObject({
      sourceFontSize: 20,
      sourceAdvance: 20,
      sourcePitch: 22,
      uniformScale: 1,
    });
  });

  it("shrinks font size and advance together only when translated text overflows", () => {
    const translatedText = "甲乙丙丁戊己庚辛壬癸";
    const region = createSourceStyledRegion({
      translatedText,
      translatedColumns: [translatedText],
    });
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.initialFontSize).toBe(20);
    expect(result.fittedFontSize).toBe(10);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].glyphs.every((glyph) => glyph.advanceY === 10)).toBe(true);
    expect(result.expandedRegion.box).toEqual(region.box);
    expect(result.layoutDiagnostics.uniformScale).toBe(0.5);
  });

  it("shrinks when trailing kinsoku punctuation makes a column too tall", () => {
    const translatedText = "甲乙丙丁戊?";
    const region = createSourceStyledRegion({
      translatedText,
      translatedColumns: [translatedText],
    });
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.initialFontSize).toBe(20);
    expect(result.fittedFontSize).toBe(16);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].glyphs.at(-1)?.sourceText).toBe("?");
    expect(result.columns[0].height).toBeLessThanOrEqual(result.verticalContentHeight + 0.5);
  });

  it("uses bubble height before shrinking a kinsoku-overflow column", () => {
    const translatedText = "甲乙丙丁戊?";
    const region = createSourceStyledRegion({
      translatedText,
      translatedColumns: [translatedText],
      bubbleMask: createMask(40, 200, () => true),
    });
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.initialFontSize).toBe(20);
    expect(result.fittedFontSize).toBe(20);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].height).toBe(120);
    expect(result.columns[0].height).toBeLessThanOrEqual(result.verticalContentHeight + 0.5);
  });

  it("includes column width in uniform overflow fitting", () => {
    const region = createSourceStyledRegion({
      box: { x: 0, y: 0, width: 49, height: 100 },
      originalLineCount: 2,
      sourceText: "日日日日日\n月月月月月",
      translatedText: "甲\n乙",
      translatedColumns: ["甲", "乙"],
      sourceLineGeometries: [
        {
          text: "日日日日日",
          direction: "v",
          box: { x: 30, y: 0, width: 20, height: 100 },
          centerX: 40,
          centerY: 50,
          width: 20,
          height: 100,
          fontSize: 20,
        },
        {
          text: "月月月月月",
          direction: "v",
          box: { x: 0, y: 0, width: 20, height: 100 },
          centerX: 10,
          centerY: 50,
          width: 20,
          height: 100,
          fontSize: 20,
        },
      ],
    });
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.initialFontSize).toBe(20);
    expect(result.fittedFontSize).toBe(19);
    const paintedGroupWidth = result.fittedFontSize
      + (result.columns.length - 1) * (result.metrics.colWidth + result.metrics.colSpacing);
    expect(paintedGroupWidth).toBeLessThanOrEqual(result.contentWidth);
    expect(result.columns.flatMap((column) => column.glyphs).every((glyph) => glyph.advanceY === 19)).toBe(true);
  });

  it("renders the same mask-extended height that layout uses", () => {
    const translatedText = "甲乙丙丁戊己庚辛壬癸";
    const region = createSourceStyledRegion({
      translatedText,
      translatedColumns: [translatedText],
      bubbleMask: createMask(40, 200, () => true),
    });
    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: createScaledMockCtx(),
    });

    expect(result.layoutDiagnostics.layoutContentHeight).toBeGreaterThan(100);
    expect(result.layoutDiagnostics.renderContentHeight).toBe(result.layoutDiagnostics.layoutContentHeight);
    expect(result.verticalContentHeight).toBe(result.layoutDiagnostics.layoutContentHeight);
  });
});
