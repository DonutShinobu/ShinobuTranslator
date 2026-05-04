import type { PipelineTypesetDebugLog, TextDirection, TextRegion, QuadPoint, TypesetDebugRegionLog } from "../types";
import {
  resolveSourceColumns,
  countTextLength,
  resolveInitialFontSize,
  expandRegionBeforeRender,
  resolveBoxPadding,
  resolveColors,
  resolveAlignment,
  mapOffscreenRectToCanvasQuad,
  cloneQuad,
  cloneRegionForTypeset,
  strokeWidth,
  metricAbs,
  quadAngle,
  quadDimensions,
  resolveOffscreenGuardPadding,
  computeFullVerticalTypeset,
  KINSOKU_NSTART,
  KINSOKU_NEND,
} from "./typesetGeometry";
import type {
  VColumn,
  VerticalCellMetrics,
  DebugColumnBox,
  RegionTypesetDebug,
  ResolvedColors,
} from "./typesetGeometry";

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
// Line type (horizontal)
// ---------------------------------------------------------------------------

type HLine = {
  text: string;
  width: number;
};

// ---------------------------------------------------------------------------
// Horizontal layout
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains Latin word characters (needs word-level wrapping).
 */
function hasLatinWords(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
}

function resolveHorizontalLetterSpacing(fontSize: number): number {
  return fontSize * horizontalLetterSpacingRatio;
}

function resolveHorizontalLineHeight(fontSize: number): number {
  return Math.max(1, Math.round(fontSize * horizontalLineHeightRatio));
}

function measureHorizontalTextWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
): number {
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }

  if (chars.length === 1) {
    return ctx.measureText(chars[0]).width;
  }

  const letterSpacing = resolveHorizontalLetterSpacing(fontSize);
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
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): HLine[] {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const cleaned = text.replace(/\n+/g, " ").trim();
  if (!cleaned) return [];

  if (hasLatinWords(cleaned)) {
    return calcHorizontalLatin(ctx, cleaned, maxWidth, fontSize);
  }
  return calcHorizontalCjk(ctx, cleaned, maxWidth, fontSize);
}

/**
 * CJK character-level line breaking with kinsoku shori.
 */
function calcHorizontalCjk(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): HLine[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: HLine[] = [];
  let line = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const trial = line + ch;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize);

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
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
        line = "";
        continue;
      }

      // If current line's last char can't end a line, move it to next line
      if (KINSOKU_NEND.has(lastChar) && line.length > 1) {
        const carry = line[line.length - 1];
        line = line.slice(0, -1);
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
        line = carry + ch;
        continue;
      }

      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
    }
    line = ch;
  }

  if (line) {
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
  }
  return lines;
}

/**
 * Latin word-level line breaking. Falls back to character-level for long words.
 */
function calcHorizontalLatin(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): HLine[] {
  const words = text.split(/\s+/);
  const lines: HLine[] = [];
  let line = "";

  for (const word of words) {
    const trial = line ? line + " " + word : word;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // If current line is non-empty, push it
    if (line) {
      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
      line = "";
    }

    // Check if the word itself exceeds maxWidth — character-break it
    if (measureHorizontalTextWidth(ctx, word, fontSize) > maxWidth) {
      const chars = [...word];
      let frag = "";
      for (const ch of chars) {
        const fragTrial = frag + ch;
        if (measureHorizontalTextWidth(ctx, fragTrial, fontSize) > maxWidth && frag) {
          lines.push({ text: frag, width: measureHorizontalTextWidth(ctx, frag, fontSize) });
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
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function drawHorizontalTextLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  mode: "stroke" | "fill",
): void {
  const chars = [...text];
  if (chars.length === 0) {
    return;
  }

  const letterSpacing = resolveHorizontalLetterSpacing(fontSize);
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
  ctx: CanvasRenderingContext2D,
  lines: HLine[],
  fontSize: number,
): number {
  if (lines.length === 0) {
    return strokeWidth(fontSize) + 2;
  }

  ctx.font = `${fontSize}px ${fontFamily}`;
  const letterSpacing = resolveHorizontalLetterSpacing(fontSize);
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
      const left = metricAbs(metrics.actualBoundingBoxLeft);
      const right = metricAbs(metrics.actualBoundingBoxRight);

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
): HTMLCanvasElement {
  const sw = strokeWidth(fontSize);
  const lineHeight = resolveHorizontalLineHeight(fontSize);

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = document.createElement("canvas");
  off.width = canvasW;
  off.height = canvasH;
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
    drawHorizontalTextLine(ctx, lines[i].text, x, y, fontSize, "stroke");
  }

  // Pass 2: fill (foreground color)
  ctx.fillStyle = colors.fg;
  for (let i = 0; i < lines.length; i++) {
    const x = computeAlignX(lines[i].width, contentWidth, padding, alignment);
    const y = offsetY + i * lineHeight;
    drawHorizontalTextLine(ctx, lines[i].text, x, y, fontSize, "fill");
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
): DebugColumnBox[] {
  if (lines.length === 0) {
    return [];
  }
  const lineHeight = resolveHorizontalLineHeight(fontSize);
  const totalTextH = lines.length * lineHeight;
  const offsetY = padding + Math.max(0, (contentHeight - totalTextH) / 2);
  return lines.map((line, index) => ({
    x: computeAlignX(line.width, contentWidth, padding, alignment),
    y: offsetY + index * lineHeight,
    width: line.width,
    height: lineHeight,
  }));
}

function traceRegionPath(ctx: CanvasRenderingContext2D, region: TextRegion): void {
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

function drawQuadPath(ctx: CanvasRenderingContext2D, quad: QuadPoint[]): void {
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
  ctx: CanvasRenderingContext2D,
  sourceRegion: TextRegion,
  expandedRegion: TextRegion,
  regionIndex: number,
  initialFontSize: number,
  debug: RegionTypesetDebug,
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
): HTMLCanvasElement {
  const sw = strokeWidth(fontSize);
  const { colWidth, colSpacing } = metrics;

  const canvasW = Math.ceil(contentWidth + padding * 2);
  const canvasH = Math.ceil(contentHeight + padding * 2);

  const off = document.createElement("canvas");
  off.width = canvasW;
  off.height = canvasH;
  const ctx = off.getContext("2d")!;

  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Total width occupied by all columns + gaps
  const totalColW = columns.length * colWidth + Math.max(0, columns.length - 1) * colSpacing;
  const offsetX = padding + (contentWidth - totalColW) / 2;

  // Columns flow right-to-left: first column is rightmost
  const colStartX = offsetX + totalColW - colWidth / 2;

  // Pass 1: stroke
  ctx.lineWidth = sw * 2;
  ctx.strokeStyle = colors.bg;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    const cx = colStartX - c * (colWidth + colSpacing);

    // Vertical alignment within column
    let startY: number;
    if (alignment === "center") {
      startY = padding + (contentHeight - col.height) / 2;
    } else if (alignment === "right") {
      startY = padding + contentHeight - col.height;
    } else {
      startY = padding;
    }

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
    const cx = colStartX - c * (colWidth + colSpacing);

    let startY: number;
    if (alignment === "center") {
      startY = padding + (contentHeight - col.height) / 2;
    } else if (alignment === "right") {
      startY = padding + contentHeight - col.height;
    } else {
      startY = padding;
    }

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
  mainCtx: CanvasRenderingContext2D,
  offCanvas: HTMLCanvasElement,
  region: TextRegion,
  boxPadding: number,
  strokePadding: number,
  contentOffsetX = 0,
  contentOffsetY = 0,
): void {
  const drawX = region.box.x + boxPadding - strokePadding - contentOffsetX;
  const drawY = region.box.y + boxPadding - strokePadding - contentOffsetY;

  const quad = region.quad;
  if (!quad) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return;
  }

  const angle = quadAngle(quad);
  const isRotated = Math.abs(angle) > 0.052;

  if (!isRotated) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return;
  }

  // Rotated quad — affine transform
  const { width: qw, height: qh } = quadDimensions(quad);

  // Center of the quad
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Uniform scale to preserve character aspect ratio.
  // strokePadding adds equal absolute pixels to both axes, but for narrow
  // vertical regions this is a larger fraction of width than height,
  // causing non-uniform sx/sy that distorts glyphs ("瘦长").
  const sx = qw / offCanvas.width;
  const sy = qh / offCanvas.height;
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
  canvas: HTMLCanvasElement;
  debugLog: PipelineTypesetDebugLog | null;
};

export async function drawTypeset(
  canvas: HTMLCanvasElement,
  regions: TextRegion[],
  targetLang?: string,
  options?: DrawTypesetOptions,
): Promise<DrawTypesetResult> {
  const debugMode = options?.debugMode === true;
  const renderText = options?.renderText !== false;
  const collectDebugLog = options?.collectDebugLog === true;
  // Ensure fonts are loaded before measuring/rendering
  await document.fonts.ready;

  fontFamily = resolveFontFamily(targetLang);

  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;

  const ctx = out.getContext("2d");
  if (!ctx) {
    throw new Error("排版阶段无法获取画布上下文");
  }

  ctx.drawImage(canvas, 0, 0);

  // We need a scratch context for text measurement (shared across regions)
  const measureCanvas = document.createElement("canvas");
  measureCanvas.width = 1;
  measureCanvas.height = 1;
  const measureCtx = measureCanvas.getContext("2d")!;

  const renderRegions = regions.map(cloneRegionForTypeset);
  const debugRegions: TypesetDebugRegionLog[] = [];

  for (let regionIndex = 0; regionIndex < renderRegions.length; regionIndex += 1) {
    const inputRegion = renderRegions[regionIndex];
    const translatedRaw = inputRegion.translatedText;
    const translated = translatedRaw || inputRegion.sourceText;
    const isVerticalInput = inputRegion.direction === "v";

    let offCanvas: HTMLCanvasElement | null = null;
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
        );
      }
      debug = {
        fittedFontSize: vResult.fittedFontSize,
        columnBoxes: vResult.debugColumnBoxes,
        columnBreakReasons: vResult.columnBreakReasons,
        columnSegmentIds: vResult.columnSegmentIds,
        columnSegmentSources: vResult.columnSegmentSources,
        offscreenWidth: vResult.offscreenWidth,
        offscreenHeight: vResult.offscreenHeight,
        boxPadding: vResult.boxPadding,
        strokePadding: vResult.strokePadding,
      };
    } else {
      // Horizontal path — unchanged
      sourceColumns = resolveSourceColumns(inputRegion);
      sourceColumnLengths = sourceColumns.map((column) => countTextLength(column));
      singleColumnMaxLength = sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null;
      preferredColumns = undefined;

      text = translated;
      if (!text.trim()) continue;

      estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(inputRegion)));
      const calcHorizontalLineCountFn = (mCtx: CanvasRenderingContext2D, t: string, maxWidth: number, fontSize: number): number => {
        const lines = calcHorizontal(mCtx, t, maxWidth, fontSize);
        return lines.length;
      };
      region = expandRegionBeforeRender(inputRegion, text, measureCtx, fontFamily, calcHorizontalLineCountFn);
      const boxPadding = resolveBoxPadding(region);
      const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
      const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
      const colors = resolveColors(region.fgColor, region.bgColor);
      const initialFontSize = estimatedInitialFontSize;

      measureCtx.font = `${initialFontSize}px ${fontFamily}`;
      const lines = calcHorizontal(measureCtx, text, contentWidth, initialFontSize);
      const fontSize = initialFontSize;
      const strokePadding = resolveHorizontalRenderPadding(measureCtx, lines, fontSize);
      const alignment = resolveAlignment(region, lines.length);
      if (renderText) {
        offCanvas = renderHorizontal(
          lines,
          fontSize,
          contentWidth,
          contentHeight,
          colors,
          alignment,
          strokePadding,
        );
      }
      debug = {
        fittedFontSize: fontSize,
        columnBoxes: buildHorizontalDebugColumnBoxes(
          lines,
          contentWidth,
          contentHeight,
          fontSize,
          alignment,
          strokePadding,
        ),
        columnBreakReasons: lines.map((_, index) => (index === 0 ? 'start' : 'wrap')),
        columnSegmentIds: lines.map(() => 1),
        columnSegmentSources: lines.map(() => 'model'),
        offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
        offscreenHeight: Math.ceil(contentHeight + strokePadding * 2),
        boxPadding,
        strokePadding,
      };
    }

    if (offCanvas) {
      compositeRegion(
        ctx,
        offCanvas,
        region,
        debug.boxPadding,
        debug.strokePadding,
      );
    }

    if (debugMode) {
      drawTypesetDebugOverlay(ctx, inputRegion, region, regionIndex, estimatedInitialFontSize, debug);
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
        )
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
        columnBoxes: debug.columnBoxes.map((box) => ({ ...box })),
        columnCanvasQuads,
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
