import type { PipelineTypesetDebugLog, TextDirection, TextRegion, QuadPoint, TypesetDebugRegionLog } from "../types";
import type { PlatformProvider, PipelineCanvas, PipelineRenderingContext } from "../runtime/platform";
import { browserPlatform as browserPlatformFallback } from "../runtime/browserPlatform";
import {
  resolveInitialFontSize,
  expandRegionBeforeRender,
  resolveBoxPadding,
  resolveColors,
  resolveAlignment,
  mapOffscreenPointToCanvas,
  mapOffscreenRectToCanvasQuad,
  cloneQuad,
  cloneRegionForTypeset,
  strokeWidth,
  metricAbs,
  quadAngle,
  quadDimensions,
  resolveOffscreenGuardPadding,
  computeFullVerticalTypeset,
  resolveHorizontalPreferredLines,
  estimateHorizontalPreferredProfile,
  tryShrinkHorizontalForMinorOverflow,
  resolveHorizontalContentHeight,
  resolveHorizontalMaskHeight,
  calcHorizontalFromLines,
  minFontSafetySize,
  getRegionQuad,
  resolveVerticalColumnPositions,
  resolveVerticalStartY,
  KINSOKU_NSTART,
  KINSOKU_NEND,
} from "./typeset/index";
import type {
  VColumn,
  VerticalCellMetrics,
  VerticalColumnAnchor,
  DebugColumnBox,
  RegionTypesetDebug,
  ResolvedColors,
  CompositeTransform,
  HLine,
  ColumnBreakReason,
  ColumnSegmentSource,
} from "./typeset/index";

// ---------------------------------------------------------------------------
// Constants (horizontal-only)
// ---------------------------------------------------------------------------

const defaultFontFamily = '"MTX-SourceHanSans-CN", "Noto Sans CJK SC", "PingFang SC", sans-serif';
let fontFamily = defaultFontFamily;

function resolveFontFamily(targetLang?: string): string {
  if (targetLang === 'zh-CHT') {
    return '"MTX-SourceHanSans-TW", "Noto Sans CJK TC", "PingFang TC", sans-serif';
  }
  return defaultFontFamily;
}
const horizontalLetterSpacingRatio = -0.05;
const horizontalLineHeightRatio = 0.93;

// ---------------------------------------------------------------------------
// Horizontal layout
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains Latin word characters (needs word-level wrapping).
 */
function hasLatinWords(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
}

function resolveHorizontalLetterSpacing(fontSize: number, scale: number = 1): number {
  return fontSize * horizontalLetterSpacingRatio * scale;
}

function resolveHorizontalLineHeight(fontSize: number, scale: number = 1): number {
  return Math.max(1, Math.round(fontSize * horizontalLineHeightRatio * scale));
}

function measureHorizontalTextWidth(
  ctx: PipelineRenderingContext,
  text: string,
  fontSize: number,
  letterSpacingScale: number = 1,
): number {
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }

  if (chars.length === 1) {
    return ctx.measureText(chars[0]).width;
  }

  const letterSpacing = resolveHorizontalLetterSpacing(fontSize, letterSpacingScale);
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    width += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) {
      width += letterSpacing;
    }
  }
  return Math.max(0, width);
}

/**
 * Split text into wrapped lines for horizontal rendering.
 * - For CJK: character-level wrapping with kinsoku shori punctuation rules.
 * - For Latin: word-level wrapping with character fallback for long words.
 */
function calcHorizontal(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacingScale: number = 1,
): HLine[] {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const cleaned = text.replace(/\n+/g, " ").trim();
  if (!cleaned) return [];

  if (hasLatinWords(cleaned)) {
    return calcHorizontalLatin(ctx, cleaned, maxWidth, fontSize, letterSpacingScale);
  }
  return calcHorizontalCjk(ctx, cleaned, maxWidth, fontSize, letterSpacingScale);
}

/**
 * CJK character-level line breaking with kinsoku shori.
 */
function calcHorizontalCjk(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacingScale: number = 1,
): HLine[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: HLine[] = [];
  let line = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const trial = line + ch;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize, letterSpacingScale);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // Line is full — push current line, but apply kinsoku rules
    if (line.length > 0) {
      const lastChar = line[line.length - 1];
      const nextChar = ch;

      // If next char can't start a line, keep it on current line
      if (KINSOKU_NSTART.has(nextChar) && line.length > 0) {
        line += ch;
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
        line = "";
        continue;
      }

      // If current line's last char can't end a line, move it to next line
      if (KINSOKU_NEND.has(lastChar) && line.length > 1) {
        const carry = line[line.length - 1];
        line = line.slice(0, -1);
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
        line = carry + ch;
        continue;
      }

      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
    }
    line = ch;
  }

  if (line) {
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
  }
  return lines;
}

/**
 * Latin word-level line breaking. Falls back to character-level for long words.
 */
function calcHorizontalLatin(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacingScale: number = 1,
): HLine[] {
  const words = text.split(/\s+/);
  const lines: HLine[] = [];
  let line = "";

  for (const word of words) {
    const trial = line ? line + " " + word : word;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize, letterSpacingScale);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // If current line is non-empty, push it
    if (line) {
      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
      line = "";
    }

    // Check if the word itself exceeds maxWidth — character-break it
    if (measureHorizontalTextWidth(ctx, word, fontSize, letterSpacingScale) > maxWidth) {
      const chars = [...word];
      let frag = "";
      for (const ch of chars) {
        const fragTrial = frag + ch;
        if (measureHorizontalTextWidth(ctx, fragTrial, fontSize, letterSpacingScale) > maxWidth && frag) {
          lines.push({ text: frag, width: measureHorizontalTextWidth(ctx, frag, fontSize, letterSpacingScale) });
          frag = ch;
        } else {
          frag = fragTrial;
        }
      }
      line = frag;
    } else {
      line = word;
    }
  }

  if (line) {
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

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

function resolveHorizontalRenderPadding(
  ctx: PipelineRenderingContext,
  lines: HLine[],
  fontSize: number,
  letterSpacingScale: number = 1,
): number {
  if (lines.length === 0) {
    return strokeWidth(fontSize) + 2;
  }

  ctx.font = `${fontSize}px ${fontFamily}`;
  const letterSpacing = resolveHorizontalLetterSpacing(fontSize, letterSpacingScale);
  let maxOverflow = 0;

  for (const line of lines) {
    const chars = [...line.text];
    if (chars.length === 0) {
      continue;
    }

    let penX = 0;
    let minX = 0;
    let maxX = line.width;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const metrics = ctx.measureText(ch);
      const left = metricAbs(metrics.actualBoundingBoxLeft ?? 0);
      const right = metricAbs(metrics.actualBoundingBoxRight ?? 0);

      minX = Math.min(minX, penX - left);
      maxX = Math.max(maxX, penX + right);

      if (i < chars.length - 1) {
        penX += metrics.width + letterSpacing;
      }
    }

    const leftOverflow = Math.max(0, -minX);
    const rightOverflow = Math.max(0, maxX - line.width);
    maxOverflow = Math.max(maxOverflow, leftOverflow, rightOverflow);
  }

  const sw = strokeWidth(fontSize);
  const basePadding = sw + 2;
  const fallbackPadding = Math.ceil(fontSize * 0.12);
  const overflowPadding = Math.max(Math.ceil(maxOverflow), fallbackPadding);
  return basePadding + overflowPadding + resolveOffscreenGuardPadding(fontSize);
}

/**
 * Render horizontal text onto an offscreen canvas with two-layer stroke.
 * Returns the offscreen canvas sized to fit the rendered text.
 */
function renderHorizontal(
  lines: HLine[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  alignment: "left" | "center" | "right",
  padding: number,
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
function computeAlignX(
  lineWidth: number,
  contentWidth: number,
  padding: number,
  alignment: "left" | "center" | "right",
): number {
  switch (alignment) {
    case "left":
      return padding;
    case "right":
      return padding + contentWidth - lineWidth;
    case "center":
    default:
      return padding + (contentWidth - lineWidth) / 2;
  }
}

function buildHorizontalDebugColumnBoxes(
  lines: HLine[],
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  alignment: "left" | "center" | "right",
  padding: number,
  lineHeightScale: number = 1,
): DebugColumnBox[] {
  if (lines.length === 0) {
    return [];
  }
  const lineHeight = resolveHorizontalLineHeight(fontSize, lineHeightScale);
  const totalTextH = lines.length * lineHeight;
  const offsetY = padding + Math.max(0, (contentHeight - totalTextH) / 2);
  return lines.map((line, index) => ({
    x: computeAlignX(line.width, contentWidth, padding, alignment),
    y: offsetY + index * lineHeight,
    width: line.width,
    height: lineHeight,
  }));
}

function traceRegionPath(ctx: PipelineRenderingContext, region: TextRegion): void {
  if (region.quad && region.quad.length === 4) {
    ctx.beginPath();
    ctx.moveTo(region.quad[0].x, region.quad[0].y);
    ctx.lineTo(region.quad[1].x, region.quad[1].y);
    ctx.lineTo(region.quad[2].x, region.quad[2].y);
    ctx.lineTo(region.quad[3].x, region.quad[3].y);
    ctx.closePath();
    return;
  }
  ctx.beginPath();
  ctx.rect(region.box.x, region.box.y, region.box.width, region.box.height);
}

function drawQuadPath(ctx: PipelineRenderingContext, quad: QuadPoint[]): void {
  if (quad.length !== 4) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  ctx.lineTo(quad[1].x, quad[1].y);
  ctx.lineTo(quad[2].x, quad[2].y);
  ctx.lineTo(quad[3].x, quad[3].y);
  ctx.closePath();
}

function drawTypesetDebugOverlay(
  ctx: PipelineRenderingContext,
  sourceRegion: TextRegion,
  expandedRegion: TextRegion,
  regionIndex: number,
  initialFontSize: number,
  debug: RegionTypesetDebug,
  transform: CompositeTransform | null,
): void {
  ctx.save();

  // source region (before expand)
  traceRegionPath(ctx, sourceRegion);
  ctx.strokeStyle = 'rgba(30, 136, 229, 0.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // expanded region (used for typeset)
  traceRegionPath(ctx, expandedRegion);
  ctx.strokeStyle = 'rgba(0, 184, 212, 0.95)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '12px "MTX-SourceHanSans-CN", "Noto Sans CJK SC", sans-serif';
  ctx.textBaseline = 'top';
  const label = `#${regionIndex + 1} init:${initialFontSize}px fit:${debug.fittedFontSize}px cols:${debug.columnBoxes.length}`;
  const labelX = Math.max(0, sourceRegion.box.x);
  const labelY = Math.max(0, sourceRegion.box.y - 18);
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(8, 15, 29, 0.86)';
  ctx.fillRect(labelX, labelY, textWidth + 10, 16);
  ctx.fillStyle = '#d6fbff';
  ctx.fillText(label, labelX + 5, labelY + 2);

  ctx.strokeStyle = 'rgba(255, 152, 0, 0.92)';
  ctx.fillStyle = 'rgba(255, 152, 0, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i < debug.columnBoxes.length; i += 1) {
    const boxQuad = mapOffscreenRectToCanvasQuad(
      expandedRegion,
      debug.columnBoxes[i],
      debug.offscreenWidth,
      debug.offscreenHeight,
      debug.boxPadding,
      debug.strokePadding,
      transform,
    );
    drawQuadPath(ctx, boxQuad);
    ctx.fill();
    ctx.stroke();

    const reason = debug.columnBreakReasons[i] ?? 'wrap';
    const reasonLabel = reason === 'both'
      ? '并'
      : reason === 'model'
      ? '模'
      : reason === 'wrap'
        ? '溢'
        : '首';
    const reasonX = Math.min(boxQuad[0].x, boxQuad[1].x, boxQuad[2].x, boxQuad[3].x);
    const reasonY = Math.max(0, Math.min(boxQuad[0].y, boxQuad[1].y, boxQuad[2].y, boxQuad[3].y) - 14);
    const reasonWidth = ctx.measureText(reasonLabel).width;
    ctx.fillStyle = 'rgba(8, 15, 29, 0.86)';
    ctx.fillRect(reasonX, reasonY, reasonWidth + 8, 13);
    ctx.fillStyle = '#ffd59a';
    ctx.fillText(reasonLabel, reasonX + 4, reasonY + 1);

    const segId = debug.columnSegmentIds[i] ?? 1;
    const segSource = debug.columnSegmentSources[i] ?? 'model';
    const segLabel = `${segId}${segSource === 'split' ? '裂' : '模'}`;
    const segX = reasonX;
    const segY = Math.max(boxQuad[0].y, boxQuad[1].y, boxQuad[2].y, boxQuad[3].y) + 2;
    const segWidth = ctx.measureText(segLabel).width;
    ctx.fillStyle = 'rgba(8, 15, 29, 0.86)';
    ctx.fillRect(segX, segY, segWidth + 8, 13);
    ctx.fillStyle = '#9ad6ff';
    ctx.fillText(segLabel, segX + 4, segY + 1);

    ctx.fillStyle = 'rgba(255, 152, 0, 0.14)';
  }

  ctx.restore();
}

/**
 * Render vertical text onto an offscreen canvas with two-layer stroke.
 * Columns flow right-to-left.
 */
function renderVertical(
  columns: VColumn[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  alignment: "left" | "center" | "right",
  metrics: VerticalCellMetrics,
  padding: number,
  columnStartOffsets?: readonly number[],
  columnAnchor?: VerticalColumnAnchor,
  platform?: PlatformProvider,
): PipelineCanvas {
  const sw = strokeWidth(fontSize);

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = platform!.createCanvas(canvasW, canvasH);
  const ctx = off.getContext("2d")!;

  ctx.font = `${fontSize}px ${fontFamily}`;
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
      ctx.strokeText(glyph.ch, cx, penY + glyph.advanceY / 2);
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
      ctx.fillText(glyph.ch, cx, penY + glyph.advanceY / 2);
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
function compositeRegion(
  mainCtx: PipelineRenderingContext,
  offCanvas: PipelineCanvas,
  region: TextRegion,
  boxPadding: number,
  strokePadding: number,
  contentOffsetX = 0,
  contentOffsetY = 0,
): CompositeTransform | null {
  const drawX = region.box.x + boxPadding - strokePadding - contentOffsetX;
  const drawY = region.box.y + boxPadding - strokePadding - contentOffsetY;

  const quad = region.quad;
  if (!quad) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return null;
  }

  const angle = quadAngle(quad);
  const isRotated = Math.abs(angle) > 0.052;

  if (!isRotated) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return null;
  }

  // Rotated quad — affine transform
  const { width: qw, height: qh } = quadDimensions(quad);

  // Center of the quad
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Uniform scale to preserve character aspect ratio.
  // Use content-area dimensions (offCanvas minus padding) as the scaling
  // denominator so that the rendered text maps 1:1 to the quad, not the
  // padded offscreen canvas.  The old formula (qw / offCanvas.width)
  // included strokePadding in the denominator but not in qw, causing
  // s < 1 and shrinking text — especially for narrow vertical columns
  // where strokePadding is a large fraction of quad width.
  const contentW = offCanvas.width - boxPadding * 2 - strokePadding * 2;
  const contentH = offCanvas.height - boxPadding * 2 - strokePadding * 2;
  const sx = qw / Math.max(1, contentW);
  const sy = qh / Math.max(1, contentH);
  const s = Math.min(sx, sy);

  mainCtx.save();
  mainCtx.translate(cx, cy);
  mainCtx.rotate(angle);
  mainCtx.scale(s, s);
  mainCtx.drawImage(
    offCanvas,
    -offCanvas.width / 2,
    -offCanvas.height / 2,
  );
  mainCtx.restore();

  return { s, cx, cy, angle };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

type DrawTypesetOptions = {
  debugMode?: boolean;
  renderText?: boolean;
  collectDebugLog?: boolean;
};

type DrawTypesetResult = {
  canvas: PipelineCanvas;
  debugLog: PipelineTypesetDebugLog | null;
};

export async function drawTypeset(
  canvas: PipelineCanvas,
  regions: TextRegion[],
  targetLang?: string,
  options?: DrawTypesetOptions,
  platform?: PlatformProvider,
): Promise<DrawTypesetResult> {
  const debugMode = options?.debugMode === true;
  const renderText = options?.renderText !== false;
  const collectDebugLog = options?.collectDebugLog === true;
  // Ensure fonts are loaded before measuring/rendering
  await (platform ?? browserPlatformFallback).waitForFonts();

  fontFamily = resolveFontFamily(targetLang);

  const out = (platform ?? browserPlatformFallback).createCanvas(canvas.width, canvas.height);

  const ctx = out.getContext("2d");
  if (!ctx) {
    throw new Error("排版阶段无法获取画布上下文");
  }

  ctx.drawImage(canvas, 0, 0);

  // We need a scratch context for text measurement (shared across regions)
  const measureCanvas = (platform ?? browserPlatformFallback).createCanvas(1, 1);
  measureCanvas.height = 1;
  const measureCtx = measureCanvas.getContext("2d")!;

  const renderRegions = regions.map(cloneRegionForTypeset);
  const debugRegions: TypesetDebugRegionLog[] = [];

  for (let regionIndex = 0; regionIndex < renderRegions.length; regionIndex += 1) {
    const inputRegion = renderRegions[regionIndex];
    const translatedRaw = inputRegion.translatedText;
    const translated = translatedRaw || inputRegion.sourceText;
    const isVerticalInput = inputRegion.direction === "v";

    let offCanvas: PipelineCanvas | null = null;
    let debug: RegionTypesetDebug;
    let region: TextRegion;
    let estimatedInitialFontSize: number;
    let text: string;
    let preferredColumns: string[] | undefined;
    let sourceColumns: string[];
    let sourceColumnLengths: number[];
    let singleColumnMaxLength: number | null;

    if (isVerticalInput) {
      const vResult = computeFullVerticalTypeset({
        region: inputRegion,
        fontFamily,
        measureCtx,
      });

      region = vResult.expandedRegion;
      estimatedInitialFontSize = vResult.initialFontSize;
      text = vResult.text;
      preferredColumns = vResult.preferredColumns;
      sourceColumns = vResult.sourceColumns;
      sourceColumnLengths = vResult.sourceColumnLengths;
      singleColumnMaxLength = vResult.singleColumnMaxLength;

      if (!text.trim()) continue;

      const colors = resolveColors(region.fgColor, region.bgColor);
      if (renderText) {
        offCanvas = renderVertical(
          vResult.columns,
          vResult.fittedFontSize,
          vResult.contentWidth,
          vResult.verticalContentHeight,
          colors,
          vResult.alignment,
          vResult.metrics,
          vResult.strokePadding,
          vResult.columnStartOffsets,
          vResult.columnAnchor,
          platform,
        );
      }
      debug = {
        fittedFontSize: vResult.fittedFontSize,
        columnBoxes: vResult.debugColumnBoxes,
        columnGlyphCenters: vResult.columns.map((col, i) => {
          const box = vResult.debugColumnBoxes[i];
          if (!box) return [];
          let penY = box.y;
          return col.glyphs.map((glyph) => {
            const center = {
              ch: glyph.ch,
              x: box.x + box.width / 2,
              y: penY + glyph.advanceY / 2,
            };
            penY += glyph.advanceY;
            return center;
          });
        }),
        columnBreakReasons: vResult.columnBreakReasons,
        columnSegmentIds: vResult.columnSegmentIds,
        columnSegmentSources: vResult.columnSegmentSources,
        layoutDiagnostics: vResult.layoutDiagnostics,
        offscreenWidth: vResult.offscreenWidth,
        offscreenHeight: vResult.offscreenHeight,
        boxPadding: vResult.boxPadding,
        strokePadding: vResult.strokePadding,
      };
    } else {
      // Horizontal path — full optimization pipeline (mirrors vertical path)

      // Step 1: resolve preferred lines + rebalance
      const horizontalPreferred = resolveHorizontalPreferredLines(inputRegion, translated);
      const preferredLineSegments = horizontalPreferred.lines;
      const preferredLines = preferredLineSegments.length > 0
        ? preferredLineSegments.map((s) => s.text)
        : undefined;

      sourceColumns = horizontalPreferred.sourceLines;
      sourceColumnLengths = horizontalPreferred.sourceLineLengths;
      singleColumnMaxLength = horizontalPreferred.singleLineMaxLength;
      preferredColumns = preferredLines;

      text = translated;
      if (!text.trim()) continue;

      // Step 2: initial font size estimation
      estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(inputRegion)));

      // Use quad real dimensions for proper sizing (handles tilted quads)
      const inputQuadDims = quadDimensions(getRegionQuad(inputRegion));

      // Cap font size by available width if single-line max length is known
      if (singleColumnMaxLength && singleColumnMaxLength > 0) {
        const boxPaddingEst = resolveBoxPadding(inputRegion);
        const availableWidth = Math.max(20, inputQuadDims.width - boxPaddingEst * 2);
        const maxFontByWidth = Math.floor(availableWidth / (singleColumnMaxLength * 1.1));
        if (maxFontByWidth > 0 && maxFontByWidth < estimatedInitialFontSize) {
          estimatedInitialFontSize = Math.max(8, maxFontByWidth);
        }
      }

      // Step 3: region expansion
      const calcHorizontalLineCountFn = (mCtx: PipelineRenderingContext, t: string, maxWidth: number, fontSize: number): number => {
        if (preferredLineSegments.length > 0) {
          mCtx.font = `${fontSize}px ${fontFamily}`;
          const result = calcHorizontalFromLines(mCtx, preferredLineSegments, maxWidth, fontSize);
          return result.lines.length;
        }
        return calcHorizontal(mCtx, t, maxWidth, fontSize).length;
      };
      region = expandRegionBeforeRender(inputRegion, text, measureCtx, fontFamily, calcHorizontalLineCountFn);

      const boxPadding = resolveBoxPadding(region);
      const regionQuadDims = quadDimensions(getRegionQuad(region));
      const contentWidth = Math.max(20, regionQuadDims.width - boxPadding * 2);
      const contentHeight = Math.max(20, regionQuadDims.height - boxPadding * 2);

      // Step 4: estimate preferred profile (dynamic spacing scales)
      const originalContentHeight = Math.max(20, inputQuadDims.height - resolveBoxPadding(inputRegion) * 2);
      const preferredProfile = estimateHorizontalPreferredProfile(
        measureCtx,
        region,
        text,
        contentWidth,
        contentHeight,
        estimatedInitialFontSize,
        fontFamily,
        preferredLines,
        originalContentHeight,
      );
      let letterSpacingScale = preferredProfile.letterSpacingScale;
      let lineHeightScale = preferredProfile.lineHeightScale;

      // Step 5: calculate lines (preferred lines or fallback)
      let fontSize = estimatedInitialFontSize;
      let lines: HLine[];
      let lineBreakReasons: ColumnBreakReason[];
      let lineSegmentIds: number[];
      let lineSegmentSources: ColumnSegmentSource[];

      if (preferredLineSegments.length > 0) {
        measureCtx.font = `${fontSize}px ${fontFamily}`;
        const hResult = calcHorizontalFromLines(
          measureCtx,
          preferredLineSegments,
          contentWidth,
          fontSize,
          letterSpacingScale,
        );
        lines = hResult.lines;
        lineBreakReasons = hResult.lineBreakReasons;
        lineSegmentIds = hResult.lineSegmentIds;
        lineSegmentSources = hResult.lineSegmentSources;
      } else {
        measureCtx.font = `${fontSize}px ${fontFamily}`;
        lines = calcHorizontal(measureCtx, text, contentWidth, fontSize, letterSpacingScale);
        lineBreakReasons = lines.map((_, index) => (index === 0 ? 'start' : 'wrap'));
        lineSegmentIds = lines.map(() => 1);
        lineSegmentSources = lines.map(() => 'model');
      }

      // Step 6: try shrink for minor overflow (1-2 char tail line)
      const calcLinesFn = (mCtx: PipelineRenderingContext, t: string, maxWidth: number, fs: number): HLine[] => {
        if (preferredLineSegments.length > 0) {
          mCtx.font = `${fs}px ${fontFamily}`;
          const result = calcHorizontalFromLines(mCtx, preferredLineSegments, maxWidth, fs, letterSpacingScale);
          return result.lines;
        }
        return calcHorizontal(mCtx, t, maxWidth, fs, letterSpacingScale);
      };

      const shrinkResult = tryShrinkHorizontalForMinorOverflow(
        measureCtx,
        text,
        contentWidth,
        estimatedInitialFontSize,
        fontFamily,
        lines,
        calcLinesFn,
      );
      fontSize = shrinkResult.fontSize;
      lines = shrinkResult.lines;

      // Recalculate break reasons if font size changed after shrink
      if (fontSize !== estimatedInitialFontSize && preferredLineSegments.length > 0) {
        measureCtx.font = `${fontSize}px ${fontFamily}`;
        const hResult = calcHorizontalFromLines(
          measureCtx,
          preferredLineSegments,
          contentWidth,
          fontSize,
          letterSpacingScale,
        );
        lineBreakReasons = hResult.lineBreakReasons;
        lineSegmentIds = hResult.lineSegmentIds;
        lineSegmentSources = hResult.lineSegmentSources;
      } else if (fontSize !== estimatedInitialFontSize) {
        lineBreakReasons = lines.map((_, index) => (index === 0 ? 'start' : 'wrap'));
        lineSegmentIds = lines.map(() => 1);
        lineSegmentSources = lines.map(() => 'model');
      }

      // Step 7: content height + mask-aware extension
      let horizontalContentHeight = resolveHorizontalContentHeight(contentHeight, fontSize);
      horizontalContentHeight = resolveHorizontalMaskHeight(
        inputRegion.bubbleMask,
        region,
        horizontalContentHeight,
        fontSize,
      );

      // Step 8: binary search font shrink if too many lines
      const targetLineCount = Math.max(
        1,
        sourceColumns.length,
        preferredLines?.length ?? 0,
        inputRegion.originalLineCount ?? 0,
      );

      if (lines.length > targetLineCount && fontSize > minFontSafetySize) {
        const minAllowed = Math.max(minFontSafetySize, Math.ceil(estimatedInitialFontSize * 0.3));
        let lo = minAllowed;
        let hi = fontSize - 1;
        let bestFs = fontSize;
        let bestLines = lines;
        let bestBreakReasons = lineBreakReasons;
        let bestSegmentIds = lineSegmentIds;
        let bestSegmentSources = lineSegmentSources;
        let bestLetterSpacingScale = letterSpacingScale;
        let bestLineHeightScale = lineHeightScale;

        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const midProfile = estimateHorizontalPreferredProfile(
            measureCtx,
            region,
            text,
            contentWidth,
            horizontalContentHeight,
            mid,
            fontFamily,
            preferredLines,
            originalContentHeight,
          );
          measureCtx.font = `${mid}px ${fontFamily}`;
          let candidateLines: HLine[];
          if (preferredLineSegments.length > 0) {
            const hResult = calcHorizontalFromLines(
              measureCtx,
              preferredLineSegments,
              contentWidth,
              mid,
              midProfile.letterSpacingScale,
            );
            candidateLines = hResult.lines;
            if (candidateLines.length <= targetLineCount) {
              bestBreakReasons = hResult.lineBreakReasons;
              bestSegmentIds = hResult.lineSegmentIds;
              bestSegmentSources = hResult.lineSegmentSources;
            }
          } else {
            candidateLines = calcHorizontal(measureCtx, text, contentWidth, mid, midProfile.letterSpacingScale);
            if (candidateLines.length <= targetLineCount) {
              bestBreakReasons = candidateLines.map((_, index) => (index === 0 ? 'start' : 'wrap'));
              bestSegmentIds = candidateLines.map(() => 1);
              bestSegmentSources = candidateLines.map(() => 'model');
            }
          }
          if (candidateLines.length <= targetLineCount) {
            bestFs = mid;
            bestLines = candidateLines;
            bestLetterSpacingScale = midProfile.letterSpacingScale;
            bestLineHeightScale = midProfile.lineHeightScale;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }

        if (bestFs !== fontSize) {
          fontSize = bestFs;
          lines = bestLines;
          lineBreakReasons = bestBreakReasons;
          lineSegmentIds = bestSegmentIds;
          lineSegmentSources = bestSegmentSources;
          letterSpacingScale = bestLetterSpacingScale;
          lineHeightScale = bestLineHeightScale;
          // Recalculate content height for new font size
          horizontalContentHeight = resolveHorizontalContentHeight(contentHeight, fontSize);
          horizontalContentHeight = resolveHorizontalMaskHeight(
            inputRegion.bubbleMask,
            region,
            horizontalContentHeight,
            fontSize,
          );
        }
      }

      const colors = resolveColors(region.fgColor, region.bgColor);

      // Step 9: stroke padding (with current spacing scale)
      measureCtx.font = `${fontSize}px ${fontFamily}`;
      const strokePadding = resolveHorizontalRenderPadding(measureCtx, lines, fontSize, letterSpacingScale);

      // Step 10: alignment
      const alignment = resolveAlignment(region, lines.length);

      // Step 11: render
      if (renderText) {
        offCanvas = renderHorizontal(
          lines,
          fontSize,
          contentWidth,
          horizontalContentHeight,
          colors,
          alignment,
          strokePadding,
          letterSpacingScale,
          lineHeightScale,
          platform,
        );
      }
      debug = {
        fittedFontSize: fontSize,
        columnBoxes: buildHorizontalDebugColumnBoxes(
          lines,
          contentWidth,
          horizontalContentHeight,
          fontSize,
          alignment,
          strokePadding,
          lineHeightScale,
        ),
        columnBreakReasons: lineBreakReasons,
        columnSegmentIds: lineSegmentIds,
        columnSegmentSources: lineSegmentSources,
        offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
        offscreenHeight: Math.ceil(horizontalContentHeight + strokePadding * 2),
        boxPadding,
        strokePadding,
      };
    }

    let transform: CompositeTransform | null = null;
    if (offCanvas) {
      transform = compositeRegion(
        ctx,
        offCanvas,
        region,
        debug.boxPadding,
        debug.strokePadding,
      );
    }

    if (debugMode) {
      drawTypesetDebugOverlay(ctx, inputRegion, region, regionIndex, estimatedInitialFontSize, debug, transform);
    }

    if (collectDebugLog) {
      const columnCanvasQuads = debug.columnBoxes.map((box) =>
        mapOffscreenRectToCanvasQuad(
          region,
          box,
          debug.offscreenWidth,
          debug.offscreenHeight,
          debug.boxPadding,
          debug.strokePadding,
          transform,
        )
      );
      const columnGlyphCenters = (debug.columnGlyphCenters ?? []).map((column) =>
        column.map((center) => {
          const mapped = mapOffscreenPointToCanvas(
            region,
            center,
            debug.offscreenWidth,
            debug.offscreenHeight,
            debug.boxPadding,
            debug.strokePadding,
            transform,
          );
          return {
            ch: center.ch,
            x: mapped.x,
            y: mapped.y,
          };
        })
      );
      const direction: TextDirection = region.direction === "h" ? "h" : "v";
      debugRegions.push({
        regionId: inputRegion.id,
        regionIndex,
        direction,
        sourceText: inputRegion.sourceText,
        translatedTextRaw: translatedRaw,
        translatedTextUsed: text,
        translatedColumnsRaw: inputRegion.translatedColumns ? [...inputRegion.translatedColumns] : [],
        preferredColumns: preferredColumns ? [...preferredColumns] : [],
        sourceColumns,
        sourceColumnLengths,
        singleColumnMaxLength,
        initialFontSize: estimatedInitialFontSize,
        fittedFontSize: debug.fittedFontSize,
        sourceBox: { ...inputRegion.box },
        expandedBox: { ...region.box },
        sourceQuad: inputRegion.quad ? cloneQuad(inputRegion.quad) : undefined,
        expandedQuad: region.quad ? cloneQuad(region.quad) : undefined,
        offscreenWidth: debug.offscreenWidth,
        offscreenHeight: debug.offscreenHeight,
        boxPadding: debug.boxPadding,
        strokePadding: debug.strokePadding,
        columnBreakReasons: [...debug.columnBreakReasons],
        columnSegmentIds: [...debug.columnSegmentIds],
        columnSegmentSources: [...debug.columnSegmentSources],
        layoutDiagnostics: debug.layoutDiagnostics ? { ...debug.layoutDiagnostics } : undefined,
        columnBoxes: debug.columnBoxes.map((box) => ({ ...box })),
        columnCanvasQuads,
        columnGlyphCenters,
      });
    }
  }

  const debugLog: PipelineTypesetDebugLog | null = collectDebugLog
    ? {
      generatedAt: new Date().toISOString(),
      regions: debugRegions,
    }
    : null;

  return {
    canvas: out,
    debugLog,
  };
}
