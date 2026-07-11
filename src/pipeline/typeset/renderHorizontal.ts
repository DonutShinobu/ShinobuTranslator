import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from "../../runtime/platform";
import { strokeWidth } from "./fontMetrics";
import type { HLine } from "./horizontalFit";
import {
  computeAlignX,
  resolveHorizontalLetterSpacing,
  resolveHorizontalLineHeight,
} from "./horizontalLayout";
import type { ResolvedColors } from "./color";

function drawHorizontalTextLine(
  ctx: PipelineRenderingContext,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  mode: "stroke" | "fill",
  letterSpacingScale: number = 1,
): void {
  const chars = [...text];
  if (chars.length === 0) {
    return;
  }

  const letterSpacing = resolveHorizontalLetterSpacing(fontSize, letterSpacingScale);
  let penX = x;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (mode === "stroke") {
      ctx.strokeText(ch, penX, y);
    } else {
      ctx.fillText(ch, penX, y);
    }
    if (i < chars.length - 1) {
      penX += ctx.measureText(ch).width + letterSpacing;
    }
  }
}


/**
 * Render horizontal text onto an offscreen canvas with two-layer stroke.
 * Returns the offscreen canvas sized to fit the rendered text.
 */
export function renderHorizontal(
  lines: HLine[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  alignment: "left" | "center" | "right",
  padding: number,
  fontFamily: string,
  letterSpacingScale: number = 1,
  lineHeightScale: number = 1,
  platform?: PlatformProvider,
): PipelineCanvas {
  const sw = strokeWidth(fontSize);
  const lineHeight = resolveHorizontalLineHeight(fontSize, lineHeightScale);

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = platform!.createCanvas(canvasW, canvasH);
  const ctx = off.getContext("2d")!;

  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";

  // Vertical centering of lines within content area
  const totalTextH = lines.length * lineHeight;
  const offsetY = padding + Math.max(0, (contentHeight - totalTextH) / 2);

  // Pass 1: stroke (background color)
  ctx.lineWidth = sw * 2;
  ctx.strokeStyle = colors.bg;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (let i = 0; i < lines.length; i++) {
    const x = computeAlignX(lines[i].width, contentWidth, padding, alignment);
    const y = offsetY + i * lineHeight;
    drawHorizontalTextLine(ctx, lines[i].text, x, y, fontSize, "stroke", letterSpacingScale);
  }

  // Pass 2: fill (foreground color)
  ctx.fillStyle = colors.fg;
  for (let i = 0; i < lines.length; i++) {
    const x = computeAlignX(lines[i].width, contentWidth, padding, alignment);
    const y = offsetY + i * lineHeight;
    drawHorizontalTextLine(ctx, lines[i].text, x, y, fontSize, "fill", letterSpacingScale);
  }

  return off;
}

/**
 * Compute x position based on alignment.
 */
