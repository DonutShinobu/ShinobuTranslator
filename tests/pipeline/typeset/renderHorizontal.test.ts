import { describe, expect, it } from "vitest";
import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from "../../../packages/image-pipeline/src/runtime/platform";
import type { HorizontalLineBox } from "../../../packages/image-pipeline/src/pipeline/typeset/horizontalFit";
import { buildHorizontalGlyphPlacements } from "../../../packages/image-pipeline/src/pipeline/typeset/horizontalFit";
import { renderHorizontal } from "../../../packages/image-pipeline/src/pipeline/typeset/renderHorizontal";

describe("renderHorizontal", () => {
  it("uses the layout baseline for both stroke and fill passes", () => {
    const strokeCalls: Array<{ text: string; x: number; y: number }> = [];
    const fillCalls: Array<{ text: string; x: number; y: number }> = [];
    const context = {
      font: "20px sans-serif",
      textBaseline: "top",
      measureText: (text: string) => ({ width: [...text].length * 10 }),
      strokeText: (text: string, x: number, y: number) => strokeCalls.push({ text, x, y }),
      fillText: (text: string, x: number, y: number) => fillCalls.push({ text, x, y }),
    } as unknown as PipelineRenderingContext;
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => context,
      toDataURL: () => "",
    } satisfies PipelineCanvas;
    const platform = {
      createCanvas: (width: number, height: number) => {
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
    } as unknown as PlatformProvider;
    const line: HorizontalLineBox = {
      text: "甲乙",
      width: 20,
      x: 13,
      topY: 8,
      baselineY: 24,
      maxWidth: 80,
      ascent: 16,
      descent: 4,
      inkAscent: 16,
      inkDescent: 4,
      inkHeight: 20,
      lineHeight: 24,
      safeInterval: { left: 0, right: 80, width: 80, source: "content" },
      naturalWidth: 20,
      visualHeight: 24,
      sourceAnchored: false,
      sourceClamped: false,
    };
    const glyphPlacements = buildHorizontalGlyphPlacements(context, [line], -1);

    renderHorizontal(
      [line],
      20,
      100,
      60,
      { fg: "#111", bg: "#fff", fgRgb: [17, 17, 17], bgRgb: [255, 255, 255] },
      5,
      "sans-serif",
      1,
      platform,
      glyphPlacements,
    );

    expect(context.textBaseline).toBe("alphabetic");
    expect(strokeCalls).toEqual([
      { text: "甲", x: 13, y: 24 },
      { text: "乙", x: 22, y: 24 },
    ]);
    expect(fillCalls).toEqual(strokeCalls);
    expect(glyphPlacements).toEqual([[
      { ch: "甲", x: 13, baselineY: 24, centerX: 18, centerY: 18, width: 10 },
      { ch: "乙", x: 22, baselineY: 24, centerX: 27, centerY: 18, width: 10 },
    ]]);
    expect(canvas).toMatchObject({ width: 110, height: 70 });
  });
});
