import { describe, expect, it } from "vitest";
import { debugRegionToColumns } from "../../benchmark/typeset/src/debug-columns";
import type { TypesetDebugRegionLog } from "../../packages/image-pipeline/src/types";

function makeDebugRegion(
  overrides: Partial<TypesetDebugRegionLog> = {},
): TypesetDebugRegionLog {
  return {
    regionId: "r1",
    regionIndex: 0,
    direction: "v",
    sourceText: "abc",
    translatedTextRaw: "abc",
    translatedTextUsed: "abc",
    translatedColumnsRaw: [],
    preferredColumns: [],
    sourceColumns: [],
    sourceColumnLengths: [],
    singleColumnMaxLength: null,
    initialFontSize: 24,
    fittedFontSize: 22,
    sourceBox: { x: 0, y: 0, width: 100, height: 100 },
    expandedBox: { x: 0, y: 0, width: 100, height: 100 },
    offscreenWidth: 100,
    offscreenHeight: 100,
    boxPadding: 0,
    strokePadding: 0,
    columnBreakReasons: [],
    columnSegmentIds: [],
    columnSegmentSources: [],
    columnBoxes: [],
    columnCanvasQuads: [],
    columnGlyphCenters: [],
    ...overrides,
  };
}

describe("debugRegionToColumns", () => {
  it("uses rendered canvas quads and glyph centers as metric columns", () => {
    const region = makeDebugRegion({
      columnCanvasQuads: [[
        { x: 90, y: 10 },
        { x: 120, y: 10 },
        { x: 120, y: 110 },
        { x: 90, y: 110 },
      ]],
      columnGlyphCenters: [[
        { ch: "a", x: 105, y: 25 },
        { ch: "b", x: 105, y: 55 },
        { ch: "c", x: 105, y: 85 },
      ]],
    });

    const [column] = debugRegionToColumns(region);

    expect(column.centerX).toBe(105);
    expect(column.topY).toBe(10);
    expect(column.bottomY).toBe(110);
    expect(column.width).toBe(30);
    expect(column.height).toBe(100);
    expect(column.estimatedFontSize).toBe(22);
    expect(column.text).toBe("abc");
    expect(column.charCenters).toEqual([
      { x: 105, y: 25 },
      { x: 105, y: 55 },
      { x: 105, y: 85 },
    ]);
    expect(column.quad).toEqual([
      { x: 90, y: 10 },
      { x: 120, y: 10 },
      { x: 120, y: 110 },
      { x: 90, y: 110 },
    ]);
  });

  it("falls back to glyph bounds when a column quad is absent", () => {
    const region = makeDebugRegion({
      columnGlyphCenters: [[
        { ch: "x", x: 10, y: 20 },
        { ch: "y", x: 14, y: 50 },
      ]],
    });

    const [column] = debugRegionToColumns(region);

    expect(column.centerX).toBe(12);
    expect(column.topY).toBe(20);
    expect(column.bottomY).toBe(50);
    expect(column.width).toBe(4);
    expect(column.height).toBe(30);
  });
});
