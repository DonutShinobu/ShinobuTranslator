import { describe, it, expect } from "vitest";
import { queryMaskMaxY, calcVertical, computeFullVerticalTypeset } from "../../../src/pipeline/typeset/index";
import type { TextRegion } from "../../../src/types";

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

  it("remeasures a wrapped glyph with the destination column advance", () => {
    const ctx = createMockCtx();
    const columns = calcVertical(
      ctx,
      "あい",
      25,
      20,
      20,
      1,
      undefined,
      undefined,
      false,
      (columnIndex) => columnIndex === 0 ? 1 : 0.75,
    );

    expect(columns).toHaveLength(2);
    expect(columns[0].glyphs[0].advanceY).toBe(20);
    expect(columns[1].glyphs[0].advanceY).toBe(15);
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

  it("enforces painted-ink spacing only for translated upright content", () => {
    const ctx = {
      ...createMockCtx(),
      measureText: () => ({
        width: 20,
        actualBoundingBoxAscent: 18,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 10,
        actualBoundingBoxRight: 10,
        fontBoundingBoxAscent: 16,
        fontBoundingBoxDescent: 4,
      }),
    } as unknown as CanvasRenderingContext2D;
    const sourceText = "一二三四五六";
    const region: TextRegion = {
      id: "translated-upright",
      box: { x: 0, y: 0, width: 40, height: 120 },
      direction: "v",
      fontSize: 40,
      originalLineCount: 1,
      sourceText,
      translatedText: "中文",
      translatedColumns: ["中文"],
      sourceLineGeometries: [{
        text: sourceText,
        direction: "v",
        box: { x: 0, y: 0, width: 40, height: 120 },
        centerX: 20,
        centerY: 60,
        width: 40,
        height: 120,
        fontSize: 20,
      }],
    };

    const result = computeFullVerticalTypeset({
      region,
      fontFamily: "sans-serif",
      measureCtx: ctx,
    });

    expect(result.fittedFontSize).toBe(20);
    expect(result.layoutDiagnostics.uprightInkOccupancyConstrained).toBe(true);
    expect(result.layoutDiagnostics.sourceAdvanceExpansionEnabled).toBe(true);
    expect(result.columns[0].glyphs).toHaveLength(2);
    expect(result.columns[0].glyphs.every((glyph) =>
      (glyph.uprightInkOccupancy ?? 0) <= 0.88,
    )).toBe(true);
  });
});
