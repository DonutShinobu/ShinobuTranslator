import { describe, expect, it } from "vitest";
import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from "../../../packages/image-pipeline/src/runtime/platform";
import type { VerticalGlyph } from "../../../packages/image-pipeline/src/pipeline/typeset/fontMetrics";
import { renderVertical } from "../../../packages/image-pipeline/src/pipeline/typeset/renderVertical";
import { tokenizeVerticalText } from "../../../packages/image-pipeline/src/pipeline/typeset/verticalOrientation";

describe("renderVertical", () => {
  it("applies the optical horizontal offset to upright glyphs", () => {
    const fillCalls: Array<{ text: string; x: number; y: number }> = [];
    const context = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      strokeText: () => {},
      fillText: (text: string, x: number, y: number) => {
        fillCalls.push({ text, x, y });
      },
      measureText: () => ({ width: 20 }),
    } as unknown as PipelineRenderingContext;
    const canvas = {
      width: 40,
      height: 40,
      getContext: () => context,
      toDataURL: () => "",
    } satisfies PipelineCanvas;
    const platform = {
      createCanvas: () => canvas,
    } as unknown as PlatformProvider;
    const token = tokenizeVerticalText("!")[0];
    if (!token) throw new Error("Expected one vertical punctuation token");
    const glyph: VerticalGlyph = {
      ...token,
      ch: token.displayText,
      advanceY: 20,
      renderInlineScale: 1,
      renderCrossScale: 1,
      renderOffsetX: 3,
      renderOffsetY: 0,
      inkWidth: 18,
      inkHeight: 10,
      boundaryGap: 0,
    };

    renderVertical(
      [{ glyphs: [glyph], height: 20 }],
      20,
      20,
      20,
      { fg: "#111", bg: "#fff", fgRgb: [17, 17, 17], bgRgb: [255, 255, 255] },
      "center",
      { colWidth: 20, defaultAdvanceY: 20, colSpacing: 5 },
      10,
      "sans-serif",
      undefined,
      undefined,
      platform,
    );

    expect(fillCalls).toEqual([{ text: token.displayText, x: 3, y: 0 }]);
  });
});
