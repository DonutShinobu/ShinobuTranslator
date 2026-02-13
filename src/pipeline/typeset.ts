import type { TextRegion, QuadPoint } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Font fallback chain for CJK text rendering. */
const fontFamily = '"Noto Sans SC", "PingFang SC", "Source Han Sans SC", sans-serif';

/**
 * CJK horizontal-to-vertical punctuation substitution map.
 * Ported from manga-image-translator's CJK_H2V table.
 */
const CJK_H2V = new Map<string, string>([
  ["‥", "︰"],
  ["—", "︱"],
  ["―", "|"],
  ["–", "︲"],
  ["_", "︳"],
  ["(", "︵"],
  [")", "︶"],
  ["（", "︵"],
  ["）", "︶"],
  ["{", "︷"],
  ["}", "︸"],
  ["〔", "︹"],
  ["〕", "︺"],
  ["【", "︻"],
  ["】", "︼"],
  ["《", "︽"],
  ["》", "︾"],
  ["〈", "︿"],
  ["〉", "﹀"],
  ["⟨", "︿"],
  ["⟩", "﹀"],
  ["「", "﹁"],
  ["」", "﹂"],
  ["『", "﹃"],
  ["』", "﹄"],
  ["[", "﹇"],
  ["]", "﹈"],
  ["…", "⋮"],
  ["⋯", "︙"],
  ["\u201C", "﹁"], // "
  ["\u201D", "﹂"], // "
  ["\u2018", "﹁"], // '
  ["\u2019", "﹂"], // '
  ["~", "︴"],
  ["〜", "︴"],
  ["～", "︴"],
  ["!", "︕"],
  ["?", "︖"],
  [".", "︒"],
  ["。", "︒"],
  [";", "︔"],
  ["；", "︔"],
  [":", "︓"],
  ["：", "︓"],
  [",", "︐"],
  ["，", "︐"],
  ["-", "︲"],
  ["−", "︲"],
  ["・", "·"],
]);

/**
 * Characters that should NOT appear at the start of a line (kinsoku shori).
 * Closing brackets, punctuation marks, etc.
 */
const KINSOKU_NSTART = new Set([
  "。", "，", "、", "！", "？", "；", "：",
  "）", "」", "』", "】", "》", "〉", "﹀",
  "﹂", "﹄", "﹈", "︶", "︸", "︺", "︼",
  "︾", "︒", "︕", "︖", "︐", "︔", "︓",
  ")", "]", "}", ".", ",", "!", "?", ";", ":",
  "⋮", "︙",
]);

/**
 * Characters that should NOT appear at the end of a line (kinsoku shori).
 * Opening brackets, etc.
 */
const KINSOKU_NEND = new Set([
  "（", "「", "『", "【", "《", "〈",
  "﹁", "﹃", "﹇", "︵", "︷", "︹", "︻", "︽", "︿",
  "(", "[", "{",
]);

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

/**
 * Convert sRGB [0,255] to CIELAB.
 * Uses D65 illuminant reference white.
 */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB -> linear
  let rl = r / 255;
  let gl = g / 255;
  let bl = b / 255;
  rl = rl > 0.04045 ? Math.pow((rl + 0.055) / 1.055, 2.4) : rl / 12.92;
  gl = gl > 0.04045 ? Math.pow((gl + 0.055) / 1.055, 2.4) : gl / 12.92;
  bl = bl > 0.04045 ? Math.pow((bl + 0.055) / 1.055, 2.4) : bl / 12.92;

  // Linear sRGB -> XYZ (D65)
  let x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  let y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  let z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;

  // XYZ -> Lab
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIE76 color difference (Euclidean distance in CIELAB space).
 */
function colorDistance(
  c1: [number, number, number],
  c2: [number, number, number],
): number {
  const lab1 = rgbToLab(c1[0], c1[1], c1[2]);
  const lab2 = rgbToLab(c2[0], c2[1], c2[2]);
  return Math.sqrt(
    (lab1[0] - lab2[0]) ** 2 +
    (lab1[1] - lab2[1]) ** 2 +
    (lab1[2] - lab2[2]) ** 2,
  );
}

type ResolvedColors = {
  fg: string;
  bg: string;
  fgRgb: [number, number, number];
  bgRgb: [number, number, number];
};

/**
 * Resolve foreground/background colors for a region.
 * Applies CIE76 contrast check — if fg and bg are too similar (ΔE < 30),
 * force bg to white (if fg is dark) or black (if fg is light).
 * Ported from manga-image-translator's fg_bg_compare().
 */
function resolveColors(
  fgColor?: [number, number, number],
  bgColor?: [number, number, number],
): ResolvedColors {
  const fg: [number, number, number] = fgColor ? [...fgColor] : [17, 17, 17];
  let bg: [number, number, number] = bgColor ? [...bgColor] : [255, 255, 255];

  if (colorDistance(fg, bg) < 30) {
    const fgAvg = (fg[0] + fg[1] + fg[2]) / 3;
    bg = fgAvg <= 127 ? [255, 255, 255] : [0, 0, 0];
  }

  return {
    fg: `rgb(${fg[0]},${fg[1]},${fg[2]})`,
    bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`,
    fgRgb: fg,
    bgRgb: bg,
  };
}

// ---------------------------------------------------------------------------
// Text length counting (ported from manga-image-translator)
// ---------------------------------------------------------------------------

/**
 * Small kana that count as half-width when measuring text length.
 * Ported from manga-image-translator's count_text_length().
 */
const halfWidthKana = new Set(["っ", "ッ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]);

/**
 * Count text length where small kana characters count as 0.5 and all others
 * count as 1.0. Used for comparing source vs translated text length.
 */
function countTextLength(text: string): number {
  let length = 0;
  for (const ch of text.trim()) {
    length += halfWidthKana.has(ch) ? 0.5 : 1;
  }
  return length;
}

/** Keep original vertical column count when translated text is within this ratio. */
const verticalColumnLockRatio = 1.3;
const isDevRuntime = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Determine whether a vertical region should lock its column count to
 * originalLineCount, preferring smaller font size over creating new columns.
 */
function shouldLockVerticalColumns(region: TextRegion, text: string): boolean {
  if (region.direction !== "v") {
    return false;
  }
  if (!region.sourceText.trim() || !text.trim()) {
    return false;
  }
  if (!region.originalLineCount || region.originalLineCount <= 0) {
    return false;
  }

  const sourceLength = countTextLength(region.sourceText.replace(/\s+/g, ""));
  if (sourceLength <= 0) {
    return false;
  }
  const translatedLength = countTextLength(text.replace(/\s+/g, ""));
  return translatedLength <= sourceLength * verticalColumnLockRatio;
}

// ---------------------------------------------------------------------------
// Line / column layout types
// ---------------------------------------------------------------------------

type HLine = {
  text: string;
  width: number;
};

type VColumn = {
  chars: string[];
  height: number;
};

type VerticalCellMetrics = {
  colWidth: number;
  advanceY: number;
  colSpacing: number;
};

type VerticalLayoutResult = {
  columns: VColumn[];
  metrics: VerticalCellMetrics;
  requiredContentWidth: number;
};

type FitVerticalResult = {
  fontSize: number;
  columns: VColumn[];
  metrics: VerticalCellMetrics;
  requiredContentWidth: number;
};

// ---------------------------------------------------------------------------
// Font size resolution
// ---------------------------------------------------------------------------

/**
 * Determine the initial font size for a region.
 * Prefers region.fontSize (from OCR/merge), falls back to box-based heuristic.
 * Applies translation length adjustment if translated text is longer.
 */
function resolveInitialFontSize(region: TextRegion): number {
  let base: number;

  if (region.fontSize && region.fontSize > 0) {
    base = region.fontSize;
  } else {
    // Heuristic: ~1/3 of box height, clamped
    base = Math.min(48, Math.max(14, Math.floor(region.box.height / 3)));
  }

  // Translation length adjustment: if translated text is significantly longer,
  // scale down font size proportionally (matching reference implementation).
  if (region.translatedText && region.sourceText) {
    const srcLen = [...region.sourceText.replace(/\s+/g, "")].length;
    const tgtLen = [...region.translatedText.replace(/\s+/g, "")].length;
    if (tgtLen > srcLen && srcLen > 0) {
      const ratio = Math.max(0.7, srcLen / tgtLen);
      base = Math.round(base * ratio);
    }
  }

  // Clamp to reasonable range
  return Math.max(10, Math.min(base, Math.round(
    Math.max(region.box.width, region.box.height) * 0.8,
  )));
}

// ---------------------------------------------------------------------------
// Horizontal layout
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains Latin word characters (needs word-level wrapping).
 */
function hasLatinWords(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
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
    return calcHorizontalLatin(ctx, cleaned, maxWidth);
  }
  return calcHorizontalCjk(ctx, cleaned, maxWidth);
}

/**
 * CJK character-level line breaking with kinsoku shori.
 */
function calcHorizontalCjk(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): HLine[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: HLine[] = [];
  let line = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const trial = line + ch;
    const trialWidth = ctx.measureText(trial).width;

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
        lines.push({ text: line, width: ctx.measureText(line).width });
        line = "";
        continue;
      }

      // If current line's last char can't end a line, move it to next line
      if (KINSOKU_NEND.has(lastChar) && line.length > 1) {
        const carry = line[line.length - 1];
        line = line.slice(0, -1);
        lines.push({ text: line, width: ctx.measureText(line).width });
        line = carry + ch;
        continue;
      }

      lines.push({ text: line, width: ctx.measureText(line).width });
    }
    line = ch;
  }

  if (line) {
    lines.push({ text: line, width: ctx.measureText(line).width });
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
): HLine[] {
  const words = text.split(/\s+/);
  const lines: HLine[] = [];
  let line = "";

  for (const word of words) {
    const trial = line ? line + " " + word : word;
    const trialWidth = ctx.measureText(trial).width;

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // If current line is non-empty, push it
    if (line) {
      lines.push({ text: line, width: ctx.measureText(line).width });
      line = "";
    }

    // Check if the word itself exceeds maxWidth — character-break it
    if (ctx.measureText(word).width > maxWidth) {
      const chars = [...word];
      let frag = "";
      for (const ch of chars) {
        const fragTrial = frag + ch;
        if (ctx.measureText(fragTrial).width > maxWidth && frag) {
          lines.push({ text: frag, width: ctx.measureText(frag).width });
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
    lines.push({ text: line, width: ctx.measureText(line).width });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Vertical layout
// ---------------------------------------------------------------------------

/**
 * Measure a single glyph's visual bounds.
 * Prefer TextMetrics actual bounding boxes; fall back to width/fontSize.
 */
function measureGlyphBox(
  ctx: CanvasRenderingContext2D,
  ch: string,
  fallbackFontSize: number,
): { width: number; height: number } {
  const metrics = ctx.measureText(ch);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? Math.abs(metrics.actualBoundingBoxLeft) : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? Math.abs(metrics.actualBoundingBoxRight) : 0;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.abs(metrics.actualBoundingBoxAscent) : 0;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.abs(metrics.actualBoundingBoxDescent) : 0;

  let width = left + right;
  let height = ascent + descent;

  if (width <= 0) {
    width = metrics.width > 0 ? metrics.width : fallbackFontSize;
  }
  if (height <= 0) {
    height = fallbackFontSize;
  }

  return { width, height };
}

/**
 * Resolve per-cell metrics for vertical layout based on real glyph bounds.
 */
function resolveVerticalCellMetrics(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  sw: number,
): VerticalCellMetrics {
  const mappedChars = [...text.replace(/\s+/g, "")].map((raw) => CJK_H2V.get(raw) ?? raw);
  const uniqueChars = Array.from(new Set(mappedChars));
  let maxGlyphWidth = 0;
  let maxGlyphHeight = 0;

  for (const ch of uniqueChars) {
    const box = measureGlyphBox(ctx, ch, fontSize);
    maxGlyphWidth = Math.max(maxGlyphWidth, box.width);
    maxGlyphHeight = Math.max(maxGlyphHeight, box.height);
  }

  const safetyPadding = Math.max(2, Math.ceil(sw * 0.8));
  const colWidth = Math.ceil(Math.max(fontSize, maxGlyphWidth) + safetyPadding);
  const advanceY = Math.ceil(Math.max(fontSize, maxGlyphHeight));
  const colSpacing = Math.max(1, Math.round(fontSize * 0.2));

  return { colWidth, advanceY, colSpacing };
}

function computeVerticalTotalWidth(columnCount: number, metrics: VerticalCellMetrics): number {
  if (columnCount <= 0) {
    return 0;
  }
  return columnCount * metrics.colWidth + Math.max(0, columnCount - 1) * metrics.colSpacing;
}

/**
 * Split text into columns for vertical rendering.
 * Characters flow top-to-bottom within a column; new columns start to the left.
 * Applies CJK_H2V punctuation substitution and kinsoku rules.
 */
function calcVertical(
  text: string,
  maxHeight: number,
  advanceY: number,
): VColumn[] {
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length === 0) return [];

  const columns: VColumn[] = [];
  let col: string[] = [];
  let colHeight = 0;

  for (let i = 0; i < chars.length; i++) {
    const raw = chars[i];
    const ch = CJK_H2V.get(raw) ?? raw;

    if (colHeight + advanceY > maxHeight && col.length > 0) {
      // Check kinsoku: next char can't start a column
      if (KINSOKU_NSTART.has(ch)) {
        col.push(ch);
        colHeight += advanceY;
        columns.push({ chars: col, height: colHeight });
        col = [];
        colHeight = 0;
        continue;
      }

      // Current col's last char can't end a column
      const lastInCol = col[col.length - 1];
      if (KINSOKU_NEND.has(lastInCol) && col.length > 1) {
        const carry = col.pop()!;
        columns.push({ chars: col, height: colHeight - advanceY });
        col = [carry, ch];
        colHeight = advanceY * 2;
        continue;
      }

      columns.push({ chars: col, height: colHeight });
      col = [];
      colHeight = 0;
    }

    col.push(ch);
    colHeight += advanceY;
  }

  if (col.length > 0) {
    columns.push({ chars: col, height: colHeight });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Rendering — two-layer stroke technique
// ---------------------------------------------------------------------------

/**
 * Stroke width adaptive to font size (7% of fontSize, minimum 1px).
 * Ported from manga-image-translator: stroke_radius = 64 * max(int(0.07 * font_size), 1)
 */
function strokeWidth(fontSize: number): number {
  return Math.max(1, Math.round(fontSize * 0.07));
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
): HTMLCanvasElement {
  const sw = strokeWidth(fontSize);
  const lineHeight = fontSize + Math.round(fontSize * 0.01);
  const padding = sw + 1;

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
    ctx.strokeText(lines[i].text, x, y);
  }

  // Pass 2: fill (foreground color)
  ctx.fillStyle = colors.fg;
  for (let i = 0; i < lines.length; i++) {
    const x = computeAlignX(lines[i].width, contentWidth, padding, alignment);
    const y = offsetY + i * lineHeight;
    ctx.fillText(lines[i].text, x, y);
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

/**
 * Render vertical text onto an offscreen canvas with two-layer stroke.
 * Columns flow right-to-left.
 *
 * Column width / per-char advance are derived from measured glyph bounds.
 * Column gap keeps the same default ratio as reference (fontSize * 0.2).
 */
function renderVertical(
  columns: VColumn[],
  fontSize: number,
  contentWidth: number,
  contentHeight: number,
  colors: ResolvedColors,
  alignment: "left" | "center" | "right",
  metrics: VerticalCellMetrics,
): HTMLCanvasElement {
  const sw = strokeWidth(fontSize);
  const { colWidth, colSpacing, advanceY } = metrics;
  const padding = sw + 2;

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
  const offsetX = padding + Math.max(0, (contentWidth - totalColW) / 2);

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
    for (const ch of col.chars) {
      ctx.strokeText(ch, cx, penY + advanceY / 2);
      penY += advanceY;
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
    for (const ch of col.chars) {
      ctx.fillText(ch, cx, penY + advanceY / 2);
      penY += advanceY;
    }
  }

  return off;
}

// ---------------------------------------------------------------------------
// Alignment resolution
// ---------------------------------------------------------------------------

/**
 * Determine text alignment for a region.
 * Ported from manga-image-translator's TextBlock.alignment property.
 */
function resolveAlignment(
  region: TextRegion,
  lineCount: number,
): "left" | "center" | "right" {
  if (lineCount <= 1) return "center";
  if (region.direction === "v") return "left"; // top-aligned in vertical
  return "center";
}

// ---------------------------------------------------------------------------
// Quad / rotation compositing
// ---------------------------------------------------------------------------

/**
 * Compute rotation angle from quad's top edge.
 * Returns angle in radians.
 */
function quadAngle(quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]): number {
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
}

/**
 * Compute the width and height of the quad (from its edges).
 */
function quadDimensions(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): { width: number; height: number } {
  const topW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const botW = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const leftH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const rightH = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  return { width: (topW + botW) / 2, height: (leftH + rightH) / 2 };
}

/**
 * Composite an offscreen-rendered text canvas onto the main canvas,
 * applying affine transform for rotation if the region has a rotated quad.
 *
 * The offscreen canvas is sized to (contentWidth + 2*padding) x (contentHeight + 2*padding).
 * We draw it at native size, positioned so that the content area aligns with the
 * region box interior (accounting for boxPadding and stroke padding).
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
  // Position where the offscreen canvas top-left should land on the main canvas.
  // The content starts at strokePadding (+ optional contentOffset) inside the offscreen canvas,
  // and should align with boxPadding inside the region box.
  const drawX = region.box.x + boxPadding - strokePadding - contentOffsetX;
  const drawY = region.box.y + boxPadding - strokePadding - contentOffsetY;

  const quad = region.quad;
  if (!quad) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return;
  }

  const angle = quadAngle(quad);
  const isRotated = Math.abs(angle) > 0.01; // ~0.6 degrees threshold

  if (!isRotated) {
    mainCtx.drawImage(offCanvas, drawX, drawY);
    return;
  }

  // Rotated quad — affine transform
  const { width: qw, height: qh } = quadDimensions(quad);

  // Center of the quad
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // Scale from offscreen canvas to quad dimensions
  const sx = qw / offCanvas.width;
  const sy = qh / offCanvas.height;

  mainCtx.save();
  mainCtx.translate(cx, cy);
  mainCtx.rotate(angle);
  mainCtx.scale(sx, sy);
  mainCtx.drawImage(
    offCanvas,
    -offCanvas.width / 2,
    -offCanvas.height / 2,
  );
  mainCtx.restore();
}

// ---------------------------------------------------------------------------
// Font size fitting loop
// ---------------------------------------------------------------------------

/**
 * Find the largest font size (starting from `initial`) that fits text
 * within the content area. Decrements by 1px until it fits or hits minimum.
 * Returns the font size and the computed layout.
 */
function fitHorizontal(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentWidth: number,
  contentHeight: number,
  initial: number,
): { fontSize: number; lines: HLine[] } {
  const preferredMinSize = 10;
  const absoluteMinSize = 8;
  let fontSize = Math.max(absoluteMinSize, initial);
  let lines: HLine[] = [];

  while (fontSize >= preferredMinSize) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    lines = calcHorizontal(ctx, text, contentWidth, fontSize);
    const lineHeight = fontSize + Math.round(fontSize * 0.01);
    if (lines.length * lineHeight <= contentHeight) {
      break;
    }
    fontSize -= 1;
  }

  fontSize = Math.max(absoluteMinSize, fontSize);
  ctx.font = `${fontSize}px ${fontFamily}`;
  lines = calcHorizontal(ctx, text, contentWidth, fontSize);

  while (fontSize > absoluteMinSize) {
    const lineHeight = fontSize + Math.round(fontSize * 0.01);
    const maxWidth = lines.reduce((max, line) => Math.max(max, line.width), 0);
    const withinHeight = lines.length * lineHeight <= contentHeight;
    const withinWidth = maxWidth <= contentWidth;
    if (withinHeight && withinWidth) {
      break;
    }
    fontSize -= 1;
    ctx.font = `${fontSize}px ${fontFamily}`;
    lines = calcHorizontal(ctx, text, contentWidth, fontSize);
  }

  return { fontSize, lines };
}

/**
 * Find the largest font size for vertical text that fits within content area.
 */
function buildVerticalLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
  forcedColSpacing?: number,
): VerticalLayoutResult {
  const sw = strokeWidth(fontSize);
  const baseMetrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const metrics = forcedColSpacing === undefined
    ? baseMetrics
    : {
        ...baseMetrics,
        colSpacing: Math.max(0, forcedColSpacing),
      };
  const columns = calcVertical(text, contentHeight, metrics.advanceY);
  const requiredContentWidth = computeVerticalTotalWidth(columns.length, metrics);
  return { columns, metrics, requiredContentWidth };
}

function applyVerticalSpacingFallback(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
  contentWidth: number,
  layout: VerticalLayoutResult,
): VerticalLayoutResult {
  if (layout.requiredContentWidth <= contentWidth || layout.metrics.colSpacing <= 0) {
    return layout;
  }
  const spacingCollapsedLayout = buildVerticalLayout(ctx, text, contentHeight, fontSize, 0);
  if (spacingCollapsedLayout.requiredContentWidth < layout.requiredContentWidth) {
    return spacingCollapsedLayout;
  }
  return layout;
}

function rebalanceVerticalColumns(
  columns: VColumn[],
  targetColumns: number,
  advanceY: number,
): VColumn[] {
  if (targetColumns <= 1 || columns.length === 0) {
    return columns;
  }

  const flatChars: string[] = [];
  for (const col of columns) {
    flatChars.push(...col.chars);
  }
  if (flatChars.length <= 1) {
    return columns;
  }

  const actualTarget = Math.min(targetColumns, flatChars.length);
  if (actualTarget <= columns.length) {
    return columns;
  }

  const rowsPerColumn = Math.ceil(flatChars.length / actualTarget);
  const buckets: string[][] = [];
  let cursor = 0;
  for (let c = 0; c < actualTarget; c += 1) {
    const next = flatChars.slice(cursor, cursor + rowsPerColumn);
    if (next.length === 0) {
      break;
    }
    buckets.push(next);
    cursor += rowsPerColumn;
  }

  // Preserve basic kinsoku constraints at column boundaries.
  for (let c = 1; c < buckets.length; c += 1) {
    while (buckets[c].length > 0 && KINSOKU_NSTART.has(buckets[c][0]) && buckets[c - 1].length > 1) {
      const moved = buckets[c - 1].pop();
      if (!moved) {
        break;
      }
      buckets[c].unshift(moved);
    }
    while (buckets[c - 1].length > 1 && KINSOKU_NEND.has(buckets[c - 1][buckets[c - 1].length - 1])) {
      const moved = buckets[c - 1].pop();
      if (!moved) {
        break;
      }
      buckets[c].unshift(moved);
    }
  }

  return buckets.map((chars) => ({
    chars,
    height: chars.length * advanceY,
  }));
}

function fitVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentWidth: number,
  contentHeight: number,
  initial: number,
  maxColumns?: number,
): FitVerticalResult {
  const absoluteMinSize = 8;
  let fontSize = Math.max(absoluteMinSize, initial);

  while (fontSize >= absoluteMinSize) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    const layout = buildVerticalLayout(ctx, text, contentHeight, fontSize);
    const withinWidth = layout.requiredContentWidth <= contentWidth;
    const withinColumnLimit = maxColumns === undefined || layout.columns.length <= maxColumns;

    if (withinWidth && withinColumnLimit) {
      return { fontSize, ...layout };
    }

    fontSize -= 1;
  }

  fontSize = absoluteMinSize;
  ctx.font = `${fontSize}px ${fontFamily}`;
  let layout = buildVerticalLayout(ctx, text, contentHeight, fontSize);
  layout = applyVerticalSpacingFallback(ctx, text, contentHeight, fontSize, contentWidth, layout);

  return { fontSize, ...layout };
}

function cloneQuad(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: quad[0].x, y: quad[0].y },
    { x: quad[1].x, y: quad[1].y },
    { x: quad[2].x, y: quad[2].y },
    { x: quad[3].x, y: quad[3].y },
  ];
}

function cloneRegionForTypeset(region: TextRegion): TextRegion {
  return {
    ...region,
    box: { ...region.box },
    quad: region.quad ? cloneQuad(region.quad) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render translated text onto the cleaned (inpainted) canvas.
 *
 * Features aligned with manga-image-translator:
 * - Vertical + horizontal text direction
 * - CJK vertical punctuation substitution (CJK_H2V)
 * - Detected fg/bg color with CIE76 contrast enforcement
 * - Two-layer stroke rendering (stroke under fill, no overlap)
 * - Adaptive stroke width (~7% of font size)
 * - Affine transform for rotated quads
 * - Font size from OCR/merge with translation length adjustment
 * - Kinsoku shori punctuation rules
 * - Word-level wrapping for Latin text
 * - Auto-alignment (center for single-line, configurable for multi-line)
 */
export async function drawTypeset(
  canvas: HTMLCanvasElement,
  regions: TextRegion[],
): Promise<HTMLCanvasElement> {
  // Ensure fonts are loaded before measuring/rendering
  await document.fonts.ready;

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

  const sortedRegions = regions
    .map(cloneRegionForTypeset)
    .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);

  for (const region of sortedRegions) {
    const text = region.translatedText || region.sourceText;
    if (!text.trim()) continue;

    const boxPadding = 6;
    const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
    const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
    const isVertical = region.direction === "v";
    const colors = resolveColors(region.fgColor, region.bgColor);
    const initialFontSize = resolveInitialFontSize(region);

    let offCanvas: HTMLCanvasElement;
    let strokePadding: number;
    let contentOffsetX = 0;
    let contentOffsetY = 0;

    if (isVertical) {
      // Vertical text path
      const lockVerticalColumns = shouldLockVerticalColumns(region, text);
      const maxColumns = lockVerticalColumns
        ? Math.max(1, region.originalLineCount ?? 1)
        : undefined;
      const { fontSize, columns, metrics, requiredContentWidth } = fitVertical(
        measureCtx, text, contentWidth, contentHeight, initialFontSize, maxColumns,
      );
      let renderColumns = columns;
      let renderRequiredContentWidth = requiredContentWidth;
      if (lockVerticalColumns && maxColumns && columns.length < maxColumns) {
        const balanced = rebalanceVerticalColumns(columns, maxColumns, metrics.advanceY);
        if (balanced.length > columns.length) {
          renderColumns = balanced;
          renderRequiredContentWidth = computeVerticalTotalWidth(renderColumns.length, metrics);
        }
      }
      const sw = strokeWidth(fontSize);
      strokePadding = sw + 2;
      if (isDevRuntime && renderRequiredContentWidth > contentWidth + 0.5) {
        console.warn("[typeset] vertical content overflows region width", {
          regionId: region.id,
          contentWidth,
          requiredContentWidth: renderRequiredContentWidth,
          fontSize,
          columns: renderColumns.length,
        });
      }
      const alignment = resolveAlignment(region, renderColumns.length);
      offCanvas = renderVertical(
        renderColumns, fontSize, contentWidth, contentHeight, colors, alignment, metrics,
      );
    } else {
      // Horizontal text path
      const { fontSize, lines } = fitHorizontal(
        measureCtx, text, contentWidth, contentHeight, initialFontSize,
      );
      const sw = strokeWidth(fontSize);
      strokePadding = sw + 1;
      const alignment = resolveAlignment(region, lines.length);
      offCanvas = renderHorizontal(
        lines, fontSize, contentWidth, contentHeight, colors, alignment,
      );
    }

    // Composite onto main canvas with rotation support
    compositeRegion(
      ctx,
      offCanvas,
      region,
      boxPadding,
      strokePadding,
      contentOffsetX,
      contentOffsetY,
    );
  }

  return out;
}

