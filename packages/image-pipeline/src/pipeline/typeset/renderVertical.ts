import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from "../../runtime/platform";
import {
  resolveVerticalColumnPositions,
  resolveVerticalStartY,
} from "./verticalFit";
import { strokeWidth } from "./fontMetrics";
import type {
  VColumn,
  VerticalColumnAnchor,
} from "./verticalFit";
import type {
  VerticalCellMetrics,
  VerticalGlyph,
} from "./fontMetrics";
import type { ResolvedColors } from "./color";
import { formatTypesetFont } from "./fontRuntime";

function renderVerticalGlyph(
  ctx: PipelineRenderingContext,
  glyph: VerticalGlyph,
  centerX: number,
  centerY: number,
  fontSize: number,
  pass: "stroke" | "fill",
): void {
  const draw = (x = 0, y = 0): void => {
    if (pass === "stroke") {
      ctx.strokeText(glyph.ch, x, y);
    } else {
      ctx.fillText(glyph.ch, x, y);
    }
  };

  ctx.save();
  ctx.translate(centerX, centerY);
  if (glyph.kind === "sideways-run") {
    ctx.rotate(Math.PI / 2);
    ctx.scale(glyph.renderInlineScale, glyph.renderCrossScale);
    draw(glyph.renderOffsetX, glyph.renderOffsetY);
  } else if (glyph.kind === "tate-chu-yoko") {
    const measuredWidth = Math.max(1, ctx.measureText(glyph.ch).width);
    const scaleX = Math.min(1, fontSize * 0.9 / measuredWidth);
    ctx.scale(scaleX, 1);
    draw(glyph.renderOffsetX);
  } else {
    draw(glyph.renderOffsetX);
  }
  ctx.restore();
}

export function renderVertical(
  columns: VColumn[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  alignment: "left" | "center" | "right",
  metrics: VerticalCellMetrics,
  padding: number,
  fontFamily: string,
  columnStartOffsets?: readonly number[],
  columnAnchor?: VerticalColumnAnchor,
  platform?: PlatformProvider,
): PipelineCanvas {
  const sw = strokeWidth(fontSize);

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = platform!.createCanvas(canvasW, canvasH);
  const ctx = off.getContext("2d")!;

  ctx.font = formatTypesetFont(fontSize, fontFamily);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const positions = resolveVerticalColumnPositions(columns.length, contentWidth, metrics, padding, columnAnchor);

  // Pass 1: stroke
  ctx.lineWidth = sw * 2;
  ctx.strokeStyle = colors.bg;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    const cx = positions.centers[c];

    const startY = resolveVerticalStartY(
      contentHeight,
      col.height,
      alignment,
      padding,
      columnStartOffsets?.[c],
    );

    let penY = startY;
    for (const glyph of col.glyphs) {
      renderVerticalGlyph(ctx, glyph, cx, penY + glyph.advanceY / 2, fontSize, "stroke");
      penY += glyph.advanceY;
    }
  }

  // Pass 2: fill
  ctx.fillStyle = colors.fg;
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    const cx = positions.centers[c];

    const startY = resolveVerticalStartY(
      contentHeight,
      col.height,
      alignment,
      padding,
      columnStartOffsets?.[c],
    );

    let penY = startY;
    for (const glyph of col.glyphs) {
      renderVerticalGlyph(ctx, glyph, cx, penY + glyph.advanceY / 2, fontSize, "fill");
      penY += glyph.advanceY;
    }
  }

  return off;
}

// ---------------------------------------------------------------------------
// Quad / rotation compositing
// ---------------------------------------------------------------------------

/**
 * Composite an offscreen-rendered text canvas onto the main canvas,
 * applying affine transform for rotation if the region has a rotated quad.
 */
