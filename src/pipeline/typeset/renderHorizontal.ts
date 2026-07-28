import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from "../../runtime/platform";
import { strokeWidth } from "./fontMetrics";
import { buildHorizontalGlyphPlacements } from "./horizontalFit";
import type { HorizontalGlyphPlacement, HorizontalLineBox } from "./horizontalFit";
import { resolveHorizontalLetterSpacing } from "./horizontalLayout";
import type { ResolvedColors } from "./color";
import { formatTypesetFont } from "./fontRuntime";

function drawHorizontalGlyphLine(
  ctx: PipelineRenderingContext,
  glyphs: readonly HorizontalGlyphPlacement[],
  mode: "stroke" | "fill",
): void {
  for (const glyph of glyphs) {
    if (mode === "stroke") {
      ctx.strokeText(glyph.ch, glyph.x, glyph.baselineY);
    } else {
      ctx.fillText(glyph.ch, glyph.x, glyph.baselineY);
    }
  }
}


/**
 * Render horizontal text onto an offscreen canvas with two-layer stroke.
 * Returns the offscreen canvas sized to fit the rendered text.
 */
export function renderHorizontal(
  lines: HorizontalLineBox[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  padding: number,
  fontFamily: string,
  letterSpacingScale: number = 1,
  platform?: PlatformProvider,
  glyphPlacements?: readonly (readonly HorizontalGlyphPlacement[])[],
): PipelineCanvas {
  const sw = strokeWidth(fontSize);

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = platform!.createCanvas(canvasW, canvasH);
  const ctx = off.getContext("2d")!;

  ctx.font = formatTypesetFont(fontSize, fontFamily);
  ctx.textBaseline = "alphabetic";
  const renderGlyphs = glyphPlacements ?? buildHorizontalGlyphPlacements(
    ctx,
    lines,
    resolveHorizontalLetterSpacing(fontSize, letterSpacingScale),
  );

  // Pass 1: stroke (background color)
  ctx.lineWidth = sw * 2;
  ctx.strokeStyle = colors.bg;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (const line of renderGlyphs) {
    drawHorizontalGlyphLine(ctx, line, "stroke");
  }

  // Pass 2: fill (foreground color)
  ctx.fillStyle = colors.fg;
  for (const line of renderGlyphs) {
    drawHorizontalGlyphLine(ctx, line, "fill");
  }

  return off;
}
