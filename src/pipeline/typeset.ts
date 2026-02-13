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

// ---------------------------------------------------------------------------
// Line / column layout types
// ---------------------------------------------------------------------------

type HLine = {
  text: string;
  width: number;
};

type VerticalGlyph = {
  ch: string;
  advanceY: number;
};

type VColumn = {
  glyphs: VerticalGlyph[];
  height: number;
};

type VerticalCellMetrics = {
  colWidth: number;
  defaultAdvanceY: number;
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

type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

// ---------------------------------------------------------------------------
// Font size resolution
// ---------------------------------------------------------------------------

/**
 * Determine the initial font size for a region.
 * Prefers region.fontSize (from OCR/merge), falls back to box-based heuristic.
 */
function resolveInitialFontSize(region: TextRegion): number {
  let base: number;

  if (region.fontSize && region.fontSize > 0) {
    base = region.fontSize;
  } else {
    // Heuristic: ~1/3 of box height, clamped
    base = Math.min(48, Math.max(14, Math.floor(region.box.height / 3)));
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

function metricAbs(value: number): number {
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

/**
 * Estimate vertical advance from font metrics.
 * In browsers we do not have FreeType's vertAdvance, so use font box / em box.
 */
function resolveFontVerticalAdvance(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
): number {
  const metrics = ctx.measureText('国');
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent) + metricAbs(metrics.fontBoundingBoxDescent);
  const emBox = metricAbs(metrics.emHeightAscent) + metricAbs(metrics.emHeightDescent);
  const actualBox = metricAbs(metrics.actualBoundingBoxAscent) + metricAbs(metrics.actualBoundingBoxDescent);
  const resolved = fontBox > 0
    ? fontBox
    : emBox > 0
      ? emBox
      : actualBox > 0
        ? actualBox
        : fontSize;
  return Math.max(1, Math.ceil(Math.max(resolved, fontSize * 0.9)));
}

/**
 * Estimate per-glyph vertical advance as an approximation of FreeType vertAdvance.
 * Keeps spacing stable while allowing smaller visual glyphs to consume less height.
 */
function resolveGlyphVerticalAdvance(
  ctx: CanvasRenderingContext2D,
  ch: string,
  fontSize: number,
  defaultAdvanceY: number,
): number {
  const metrics = ctx.measureText(ch);
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent) + metricAbs(metrics.fontBoundingBoxDescent);
  const emBox = metricAbs(metrics.emHeightAscent) + metricAbs(metrics.emHeightDescent);
  const actualBox = metricAbs(metrics.actualBoundingBoxAscent) + metricAbs(metrics.actualBoundingBoxDescent);

  const baseAdvance = fontBox > 0
    ? fontBox
    : emBox > 0
      ? emBox
      : defaultAdvanceY;
  const minAdvance = Math.max(actualBox, defaultAdvanceY * 0.72);
  const stabilizedAdvance = Math.max(baseAdvance, defaultAdvanceY * 0.85, fontSize * 0.8);

  return Math.max(1, Math.ceil(Math.max(minAdvance, stabilizedAdvance)));
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

  for (const ch of uniqueChars) {
    const box = measureGlyphBox(ctx, ch, fontSize);
    maxGlyphWidth = Math.max(maxGlyphWidth, box.width);
  }

  const defaultAdvanceY = resolveFontVerticalAdvance(ctx, fontSize);
  const safetyPadding = Math.max(2, Math.ceil(sw * 0.8));
  const colWidth = Math.ceil(Math.max(fontSize, maxGlyphWidth) + safetyPadding);
  const colSpacing = Math.max(1, Math.round(fontSize * 0.2));

  return { colWidth, defaultAdvanceY, colSpacing };
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
  ctx: CanvasRenderingContext2D,
  text: string,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
): VColumn[] {
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length === 0) return [];

  const advanceCache = new Map<string, number>();
  const getAdvance = (ch: string): number => {
    const cached = advanceCache.get(ch);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveGlyphVerticalAdvance(ctx, ch, fontSize, defaultAdvanceY);
    advanceCache.set(ch, resolved);
    return resolved;
  };

  const columns: VColumn[] = [];
  let col: VerticalGlyph[] = [];
  let colHeight = 0;

  for (let i = 0; i < chars.length; i++) {
    const raw = chars[i];
    const ch = CJK_H2V.get(raw) ?? raw;
    const advanceY = getAdvance(ch);

    if (colHeight + advanceY > maxHeight && col.length > 0) {
      // Check kinsoku: next char can't start a column
      if (KINSOKU_NSTART.has(ch)) {
        col.push({ ch, advanceY });
        colHeight += advanceY;
        columns.push({ glyphs: col, height: colHeight });
        col = [];
        colHeight = 0;
        continue;
      }

      // Current col's last char can't end a column
      const lastInCol = col[col.length - 1];
      if (KINSOKU_NEND.has(lastInCol.ch) && col.length > 1) {
        const carry = col.pop()!;
        columns.push({ glyphs: col, height: colHeight - carry.advanceY });
        col = [carry, { ch, advanceY }];
        colHeight = carry.advanceY + advanceY;
        continue;
      }

      columns.push({ glyphs: col, height: colHeight });
      col = [];
      colHeight = 0;
    }

    col.push({ ch, advanceY });
    colHeight += advanceY;
  }

  if (col.length > 0) {
    columns.push({ glyphs: col, height: colHeight });
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
  const { colWidth, colSpacing } = metrics;
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
  ctx.font = `${fontSize}px ${fontFamily}`;
  const sw = strokeWidth(fontSize);
  const baseMetrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const metrics = forcedColSpacing === undefined
    ? baseMetrics
    : {
        ...baseMetrics,
        colSpacing: Math.max(0, forcedColSpacing),
      };
  const columns = calcVertical(ctx, text, contentHeight, fontSize, metrics.defaultAdvanceY);
  const requiredContentWidth = computeVerticalTotalWidth(columns.length, metrics);
  return { columns, metrics, requiredContentWidth };
}

function fitVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentWidth: number,
  contentHeight: number,
  initial: number,
): FitVerticalResult {
  const absoluteMinSize = 8;
  let fontSize = Math.max(absoluteMinSize, initial);

  while (fontSize >= absoluteMinSize) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    const layout = buildVerticalLayout(ctx, text, contentHeight, fontSize);
    if (layout.requiredContentWidth <= contentWidth) {
      return { fontSize, ...layout };
    }

    fontSize -= 1;
  }

  fontSize = absoluteMinSize;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const layout = buildVerticalLayout(ctx, text, contentHeight, fontSize);

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

function boxToQuad(region: TextRegion): Quad {
  const x0 = region.box.x;
  const y0 = region.box.y;
  const x1 = region.box.x + region.box.width;
  const y1 = region.box.y + region.box.height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function getRegionQuad(region: TextRegion): Quad {
  if (region.quad) {
    return cloneQuad(region.quad);
  }
  return boxToQuad(region);
}

function quadCenter(quad: Quad): { x: number; y: number } {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

function rotatePoint(point: QuadPoint, cx: number, cy: number, angle: number): QuadPoint {
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

function rotateQuad(quad: Quad, cx: number, cy: number, angle: number): Quad {
  return [
    rotatePoint(quad[0], cx, cy, angle),
    rotatePoint(quad[1], cx, cy, angle),
    rotatePoint(quad[2], cx, cy, angle),
    rotatePoint(quad[3], cx, cy, angle),
  ];
}

function quadBounds(quad: Quad): { minX: number; minY: number; maxX: number; maxY: number } {
  const minX = Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const minY = Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const maxX = Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const maxY = Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  return { minX, minY, maxX, maxY };
}

function scaleQuadFromOrigin(
  quad: Quad,
  xfact: number,
  yfact: number,
  originX: number,
  originY: number,
): Quad {
  return [
    {
      x: originX + (quad[0].x - originX) * xfact,
      y: originY + (quad[0].y - originY) * yfact,
    },
    {
      x: originX + (quad[1].x - originX) * xfact,
      y: originY + (quad[1].y - originY) * yfact,
    },
    {
      x: originX + (quad[2].x - originX) * xfact,
      y: originY + (quad[2].y - originY) * yfact,
    },
    {
      x: originX + (quad[3].x - originX) * xfact,
      y: originY + (quad[3].y - originY) * yfact,
    },
  ];
}

function updateRegionGeometryFromQuad(region: TextRegion, quad: Quad): void {
  const bounds = quadBounds(quad);
  const x = Math.floor(bounds.minX);
  const y = Math.floor(bounds.minY);
  const right = Math.ceil(bounds.maxX);
  const bottom = Math.ceil(bounds.maxY);
  region.quad = quad;
  region.box = {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function countNeededRowsAtFontSize(
  measureCtx: CanvasRenderingContext2D,
  text: string,
  contentWidth: number,
  fontSize: number,
): number {
  const lines = calcHorizontal(measureCtx, text, contentWidth, fontSize);
  return Math.max(1, lines.length);
}

function countNeededColumnsAtFontSize(
  measureCtx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
): number {
  const sw = strokeWidth(fontSize);
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  const metrics = resolveVerticalCellMetrics(measureCtx, text, fontSize, sw);
  const columns = calcVertical(measureCtx, text, contentHeight, fontSize, metrics.defaultAdvanceY);
  return Math.max(1, columns.length);
}

function expandRegionBeforeRender(
  region: TextRegion,
  text: string,
  measureCtx: CanvasRenderingContext2D,
): TextRegion {
  const expanded = cloneRegionForTypeset(region);
  const initialFontSize = resolveInitialFontSize(expanded);
  let targetFontSize = initialFontSize;
  expanded.fontSize = targetFontSize;

  const usedRowsOrCols = Math.max(1, expanded.originalLineCount ?? 1);
  const contentWidth = Math.max(20, expanded.box.width - 12);
  const contentHeight = Math.max(20, expanded.box.height - 12);

  const quad = getRegionQuad(expanded);
  const center = quadCenter(quad);
  const angle = quadAngle(quad);
  const unrotatedQuad = rotateQuad(quad, center.x, center.y, -angle);
  const unrotatedBounds = quadBounds(unrotatedQuad);

  let singleAxisExpanded = false;

  if ((expanded.direction ?? "h") === "h") {
    const neededRows = countNeededRowsAtFontSize(measureCtx, text, contentWidth, initialFontSize);
    if (neededRows > usedRowsOrCols) {
      // With top-edge-based unrotation, extra rows consume height (y-axis).
      const yfact = ((neededRows - usedRowsOrCols) / usedRowsOrCols) + 1;
      const scaledUnrotated = scaleQuadFromOrigin(
        unrotatedQuad,
        1,
        yfact,
        unrotatedBounds.minX,
        unrotatedBounds.minY,
      );
      const scaled = rotateQuad(scaledUnrotated, center.x, center.y, angle);
      updateRegionGeometryFromQuad(expanded, scaled);
      singleAxisExpanded = true;
    }
  } else {
    const neededCols = countNeededColumnsAtFontSize(measureCtx, text, contentHeight, initialFontSize);
    if (neededCols > usedRowsOrCols) {
      // Vertical columns grow along width (x-axis) in this coordinate frame.
      const xfact = ((neededCols - usedRowsOrCols) / usedRowsOrCols) + 1;
      const scaledUnrotated = scaleQuadFromOrigin(
        unrotatedQuad,
        xfact,
        1,
        unrotatedBounds.minX,
        unrotatedBounds.minY,
      );
      const scaled = rotateQuad(scaledUnrotated, center.x, center.y, angle);
      updateRegionGeometryFromQuad(expanded, scaled);
      singleAxisExpanded = true;
    }
  }

  if (!singleAxisExpanded) {
    const sourceLength = countTextLength(expanded.sourceText);
    const translatedLength = countTextLength(text.trim());
    let targetScale = 1;

    if (sourceLength > 0 && translatedLength > sourceLength) {
      const increasePercentage = (translatedLength - sourceLength) / sourceLength;
      const fontIncreaseRatio = Math.min(1.5, Math.max(1.0, 1 + increasePercentage * 0.3));
      targetFontSize = Math.max(1, Math.round(targetFontSize * fontIncreaseRatio));
      targetScale = Math.max(1, Math.min(1 + increasePercentage * 0.3, 2));
    }

    const fontSizeScale = initialFontSize > 0
      ? (((targetFontSize - initialFontSize) / initialFontSize) * 0.4 + 1)
      : 1;
    let finalScale = Math.max(fontSizeScale, targetScale);
    finalScale = Math.max(1, Math.min(finalScale, 1.1));

    if (finalScale > 1.001) {
      const bounds = quadBounds(unrotatedQuad);
      const originX = (bounds.minX + bounds.maxX) / 2;
      const originY = (bounds.minY + bounds.maxY) / 2;
      const scaledUnrotated = scaleQuadFromOrigin(
        unrotatedQuad,
        finalScale,
        finalScale,
        originX,
        originY,
      );
      const scaled = rotateQuad(scaledUnrotated, center.x, center.y, angle);
      updateRegionGeometryFromQuad(expanded, scaled);
    }
  }

  expanded.fontSize = Math.max(1, Math.round(targetFontSize));
  return expanded;
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

  const renderRegions = regions.map(cloneRegionForTypeset);

  for (const inputRegion of renderRegions) {
    const text = inputRegion.translatedText || inputRegion.sourceText;
    if (!text.trim()) continue;

    const region = expandRegionBeforeRender(inputRegion, text, measureCtx);
    const boxPadding = 6;
    const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
    const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
    const isVertical = region.direction === "v";
    const colors = resolveColors(region.fgColor, region.bgColor);
    const initialFontSize = Math.max(8, Math.round(region.fontSize ?? resolveInitialFontSize(region)));

    let offCanvas: HTMLCanvasElement;
    let strokePadding: number;

    if (isVertical) {
      const { fontSize, columns, metrics } = fitVertical(
        measureCtx, text, contentWidth, contentHeight, initialFontSize,
      );
      const sw = strokeWidth(fontSize);
      strokePadding = sw + 2;
      const alignment = resolveAlignment(region, columns.length);
      offCanvas = renderVertical(
        columns, fontSize, contentWidth, contentHeight, colors, alignment, metrics,
      );
    } else {
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

    compositeRegion(
      ctx,
      offCanvas,
      region,
      boxPadding,
      strokePadding,
    );
  }

  return out;
}

