import type { TextRegion, QuadPoint } from "../types";

// ---------------------------------------------------------------------------
// Constants
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
const verticalAdvanceTightenRatio = 0.9;
const verticalColumnSpacingRatio = 0.1;
const minVerticalAdvanceScale = 0.75;
const minVerticalColSpacingScale = 0.5;
const verticalContentHeightExpandBaseRatio = 0.08;
const verticalContentHeightExpandFontRatio = 0.003;
const minVerticalContentHeightExpandPx = 6;
const minFontSafetySize = 8;
const minorOverflowMaxGlyphCount = 2;
const minorOverflowShrinkMinScale = 0.8;
const minOffscreenGuardPaddingPx = 8;
const offscreenGuardPaddingByFontRatio = 0.35;

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

function charLength(ch: string): number {
  return halfWidthKana.has(ch) ? 0.5 : 1;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function splitColumns(text: string): string[] {
  return text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function splitByTextLength(text: string, maxLength: number): { kept: string; overflow: string } {
  const chars = [...text];
  let consumed = 0;
  let splitIndex = chars.length;

  for (let i = 0; i < chars.length; i++) {
    const next = consumed + charLength(chars[i]);
    if (next > maxLength) {
      splitIndex = i;
      break;
    }
    consumed = next;
  }

  return {
    kept: chars.slice(0, splitIndex).join(''),
    overflow: chars.slice(splitIndex).join(''),
  };
}

function resolveSourceColumns(region: TextRegion): string[] {
  const fromText = splitColumns(region.sourceText);
  if (fromText.length > 0) {
    return fromText;
  }
  const fallback = region.sourceText.trim();
  return fallback ? [fallback] : [];
}

function resolveTranslatedColumns(region: TextRegion, translatedText: string): PreferredColumnSegment[] {
  if (region.translatedColumns && region.translatedColumns.length > 0) {
    return region.translatedColumns
      .map((column) => column.trim())
      .filter(Boolean)
      .map((text) => ({ text, source: 'model' as const }));
  }
  const fromText = splitColumns(translatedText);
  if (fromText.length > 0) {
    return fromText.map((text) => ({ text, source: 'model' as const }));
  }
  const fallback = translatedText.trim();
  return fallback ? [{ text: fallback, source: 'model' }] : [];
}

function rebalanceVerticalColumns(
  sourceColumns: string[],
  translatedColumns: PreferredColumnSegment[],
): PreferredColumnSegment[] {
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const baselineLength = Math.max(1, ...sourceLengths);
  const normalizedTranslated = translatedColumns
    .map((column) => ({ text: column.text.trim(), source: column.source }))
    .filter((column) => column.text.length > 0);

  if (normalizedTranslated.length === 0) {
    return [];
  }

  const targetColumns = Math.max(sourceLengths.length, normalizedTranslated.length, 1);
  const output: PreferredColumnSegment[] = [];
  let carry = '';
  let carrySource: ColumnSegmentSource = 'split';
  let columnIndex = 0;

  while (columnIndex < targetColumns || carry.trim()) {
    const translatedItem = normalizedTranslated[columnIndex];
    const hadCarry = carry.trim().length > 0;
    const current = `${carry}${translatedItem?.text ?? ''}`.trim();
    const currentSource: ColumnSegmentSource = hadCarry
      ? 'split'
      : translatedItem?.source ?? carrySource;
    carry = '';

    if (!current) {
      output.push({ text: '', source: currentSource });
      columnIndex += 1;
      continue;
    }

    const sourceLength = sourceLengths[columnIndex]
      ?? sourceLengths[sourceLengths.length - 1]
      ?? baselineLength;
    const currentLength = countTextLength(current);

    if (currentLength <= sourceLength) {
      output.push({ text: current, source: currentSource });
      columnIndex += 1;
      continue;
    }

    if (currentLength <= baselineLength) {
      output.push({ text: current, source: currentSource });
      columnIndex += 1;
      continue;
    }

    if (columnIndex >= targetColumns - 1) {
      output.push({ text: current, source: currentSource });
      carry = '';
      columnIndex += 1;
      continue;
    }

    const { kept, overflow } = splitByTextLength(current, baselineLength);
    output.push({ text: kept || current, source: currentSource });
    carry = overflow;
    carrySource = 'split';
    columnIndex += 1;
  }

  return output.filter((column) => column.text.trim().length > 0);
}

function resolveVerticalPreferredColumns(region: TextRegion, translatedText: string): PreferredColumnSegment[] {
  const sourceColumns = resolveSourceColumns(region);
  const translatedColumns = resolveTranslatedColumns(region, translatedText);
  if (translatedColumns.length === 0) {
    return [];
  }
  return rebalanceVerticalColumns(sourceColumns, translatedColumns);
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

type BuildVerticalLayoutOptions = {
  colSpacingScale?: number;
  advanceScale?: number;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
};

type VerticalLayoutResult = {
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  requiredContentWidth: number;
};

type ColumnBreakReason = 'start' | 'model' | 'wrap' | 'both';
type ColumnSegmentSource = 'model' | 'split';

type PreferredColumnSegment = {
  text: string;
  source: ColumnSegmentSource;
};

type DebugColumnBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type RegionTypesetDebug = {
  fittedFontSize: number;
  columnBoxes: DebugColumnBox[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
};

type VerticalFitOptions = {
  targetColumnCount?: number;
  preferredColumns?: string[];
  preferredProfile?: {
    advanceScale: number;
    colSpacingScale: number;
  };
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
  advanceScale = 1,
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
  const minAdvance = Math.max(actualBox, defaultAdvanceY * 0.68);
  const stabilizedAdvance = Math.max(baseAdvance, defaultAdvanceY * 0.82, fontSize * 0.76);
  const resolvedAdvance = Math.max(minAdvance, stabilizedAdvance) * verticalAdvanceTightenRatio * advanceScale;

  return Math.max(1, Math.ceil(Math.max(actualBox, resolvedAdvance)));
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
  const colSpacing = Math.max(1, Math.round(fontSize * verticalColumnSpacingRatio));

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
  advanceScale = 1,
): VColumn[] {
  const chars = [...text.replace(/\s+/g, "")];
  if (chars.length === 0) return [];

  const advanceCache = new Map<string, number>();
  const getAdvance = (ch: string): number => {
    const cached = advanceCache.get(ch);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveGlyphVerticalAdvance(ctx, ch, fontSize, defaultAdvanceY, advanceScale);
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

function calcVerticalFromColumns(
  ctx: CanvasRenderingContext2D,
  preferredColumns: string[],
  preferredColumnSources: ColumnSegmentSource[] | undefined,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
): {
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
} {
  const mergeSegmentColumnsByMaxLength = (
    segmentColumns: VColumn[],
    segmentMaxGlyphCount: number,
  ): VColumn[] => {
    if (segmentColumns.length <= 1) {
      return segmentColumns;
    }
    const merged: VColumn[] = [];
    for (let i = 0; i < segmentColumns.length; i += 1) {
      const current = segmentColumns[i];
      const previous = merged[merged.length - 1];
      if (!previous) {
        merged.push(current);
        continue;
      }
      const mergedGlyphCount = previous.glyphs.length + current.glyphs.length;
      const mergedHeight = previous.height + current.height;
      const canMergeBySameSegmentMax = mergedGlyphCount <= segmentMaxGlyphCount;
      if (canMergeBySameSegmentMax && mergedHeight <= maxHeight) {
        previous.glyphs.push(...current.glyphs);
        previous.height = mergedHeight;
        continue;
      }
      merged.push(current);
    }
    return merged;
  };

  const columns: VColumn[] = [];
  const columnBreakReasons: ColumnBreakReason[] = [];
  const columnSegmentIds: number[] = [];
  const columnSegmentSources: ColumnSegmentSource[] = [];
  let hasOutput = false;
  let previousSegmentOverflowed = false;
  let segmentIndex = 0;

  for (const source of preferredColumns) {
    const segment = source.trim();
    if (!segment) {
      continue;
    }
    segmentIndex += 1;
    const segmentSource = preferredColumnSources?.[segmentIndex - 1] ?? 'model';
    const segmentColumns = calcVertical(
      ctx,
      segment,
      maxHeight,
      fontSize,
      defaultAdvanceY,
      advanceScale,
    );
    const segmentMaxGlyphCount = Math.max(1, ...segmentColumns.map((column) => column.glyphs.length));
    if (segmentColumns.length === 0) {
      previousSegmentOverflowed = false;
      continue;
    }

    const canFollowPrevious = hasOutput
      && columns.length > 0
      && (previousSegmentOverflowed || segmentSource === 'split');
    if (canFollowPrevious) {
      const lastColumn = columns[columns.length - 1];
      const firstColumn = segmentColumns[0];
      while (firstColumn.glyphs.length > 0) {
        const glyph = firstColumn.glyphs[0];
        if (lastColumn.height + glyph.advanceY > maxHeight) {
          break;
        }
        firstColumn.glyphs.shift();
        lastColumn.glyphs.push(glyph);
        lastColumn.height += glyph.advanceY;
      }
      if (firstColumn.glyphs.length === 0) {
        segmentColumns.shift();
      } else {
        firstColumn.height = firstColumn.glyphs.reduce((sum, glyph) => sum + glyph.advanceY, 0);
      }
    }

    const balancedSegmentColumns = mergeSegmentColumnsByMaxLength(segmentColumns, segmentMaxGlyphCount);

    for (let i = 0; i < balancedSegmentColumns.length; i += 1) {
      columns.push(balancedSegmentColumns[i]);
      columnSegmentIds.push(segmentIndex);
      columnSegmentSources.push(segmentSource);
      if (!hasOutput && i === 0) {
        columnBreakReasons.push('start');
        hasOutput = true;
        continue;
      }
      if (i === 0) {
        columnBreakReasons.push(canFollowPrevious ? 'both' : 'model');
        hasOutput = true;
        continue;
      }
      columnBreakReasons.push('wrap');
    }

    previousSegmentOverflowed = balancedSegmentColumns.length > 1;
  }
  return { columns, columnBreakReasons, columnSegmentIds, columnSegmentSources };
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

function resolveVerticalRenderPadding(
  ctx: CanvasRenderingContext2D,
  columns: VColumn[],
  fontSize: number,
  metrics: VerticalCellMetrics,
): number {
  if (columns.length === 0) {
    return strokeWidth(fontSize) + 2;
  }

  ctx.font = `${fontSize}px ${fontFamily}`;

  let maxOverflow = 0;
  const halfColWidth = metrics.colWidth / 2;

  for (const col of columns) {
    for (const glyph of col.glyphs) {
      const measured = ctx.measureText(glyph.ch);
      const left = metricAbs(measured.actualBoundingBoxLeft);
      const right = metricAbs(measured.actualBoundingBoxRight);
      const ascent = metricAbs(measured.actualBoundingBoxAscent);
      const descent = metricAbs(measured.actualBoundingBoxDescent);

      const xOverflow = Math.max(0, left - halfColWidth, right - halfColWidth);
      const halfAdvance = glyph.advanceY / 2;
      const yOverflow = Math.max(0, ascent - halfAdvance, descent - halfAdvance);
      maxOverflow = Math.max(maxOverflow, xOverflow, yOverflow);
    }
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

function resolveVerticalStartY(
  contentHeight: number,
  columnHeight: number,
  alignment: "left" | "center" | "right",
  padding: number,
): number {
  if (alignment === "center") {
    return padding + (contentHeight - columnHeight) / 2;
  }
  if (alignment === "right") {
    return padding + contentHeight - columnHeight;
  }
  return padding;
}

function buildVerticalDebugColumnBoxes(
  columns: VColumn[],
  contentWidth: number,
  contentHeight: number,
  metrics: VerticalCellMetrics,
  alignment: "left" | "center" | "right",
  padding: number,
): DebugColumnBox[] {
  if (columns.length === 0) {
    return [];
  }
  const totalColW = columns.length * metrics.colWidth + Math.max(0, columns.length - 1) * metrics.colSpacing;
  const offsetX = padding + (contentWidth - totalColW) / 2;
  const colStartX = offsetX + totalColW - metrics.colWidth / 2;

  const boxes: DebugColumnBox[] = [];
  for (let c = 0; c < columns.length; c += 1) {
    const col = columns[c];
    const cx = colStartX - c * (metrics.colWidth + metrics.colSpacing);
    const startY = resolveVerticalStartY(contentHeight, col.height, alignment, padding);
    boxes.push({
      x: cx - metrics.colWidth / 2,
      y: startY,
      width: metrics.colWidth,
      height: col.height,
    });
  }
  return boxes;
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

function mapOffscreenPointToCanvas(
  region: TextRegion,
  point: QuadPoint,
  offscreenWidth: number,
  offscreenHeight: number,
  boxPadding: number,
  strokePadding: number,
): QuadPoint {
  const drawX = region.box.x + boxPadding - strokePadding;
  const drawY = region.box.y + boxPadding - strokePadding;
  const quad = region.quad;
  if (!quad) {
    return { x: drawX + point.x, y: drawY + point.y };
  }

  const angle = quadAngle(quad);
  const isRotated = Math.abs(angle) > 0.01;
  if (!isRotated) {
    return { x: drawX + point.x, y: drawY + point.y };
  }

  const { width: qw, height: qh } = quadDimensions(quad);
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const sx = qw / Math.max(1, offscreenWidth);
  const sy = qh / Math.max(1, offscreenHeight);
  const localX = (point.x - offscreenWidth / 2) * sx;
  const localY = (point.y - offscreenHeight / 2) * sy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  };
}

function mapOffscreenRectToCanvasQuad(
  region: TextRegion,
  box: DebugColumnBox,
  offscreenWidth: number,
  offscreenHeight: number,
  boxPadding: number,
  strokePadding: number,
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  const p0 = mapOffscreenPointToCanvas(
    region,
    { x: box.x, y: box.y },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p1 = mapOffscreenPointToCanvas(
    region,
    { x: box.x + box.width, y: box.y },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p2 = mapOffscreenPointToCanvas(
    region,
    { x: box.x + box.width, y: box.y + box.height },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p3 = mapOffscreenPointToCanvas(
    region,
    { x: box.x, y: box.y + box.height },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  return [p0, p1, p2, p3];
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
 * Find the largest font size for vertical text that fits within content area.
 */
function buildVerticalLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
  options?: BuildVerticalLayoutOptions,
): VerticalLayoutResult {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const sw = strokeWidth(fontSize);
  const baseMetrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const colSpacingScale = options?.colSpacingScale ?? 1;
  const advanceScale = options?.advanceScale ?? 1;
  const metrics = {
    ...baseMetrics,
    colSpacing: Math.max(0, Math.round(baseMetrics.colSpacing * colSpacingScale)),
  };

  let columns: VColumn[];
  let columnBreakReasons: ColumnBreakReason[];
  let columnSegmentIds: number[];
  let columnSegmentSources: ColumnSegmentSource[];
  if (options?.preferredColumns && options.preferredColumns.length > 0) {
    const detailed = calcVerticalFromColumns(
      ctx,
      options.preferredColumns,
      options.preferredColumnSources,
      contentHeight,
      fontSize,
      metrics.defaultAdvanceY,
      advanceScale,
    );
    columns = detailed.columns;
    columnBreakReasons = detailed.columnBreakReasons;
    columnSegmentIds = detailed.columnSegmentIds;
    columnSegmentSources = detailed.columnSegmentSources;
  } else {
    columns = calcVertical(
      ctx,
      text,
      contentHeight,
      fontSize,
      metrics.defaultAdvanceY,
      advanceScale,
    );
    columnBreakReasons = columns.map((_, index) => (index === 0 ? 'start' : 'wrap'));
    columnSegmentIds = columns.map(() => 1);
    columnSegmentSources = columns.map(() => 'model');
  }
  const requiredContentWidth = computeVerticalTotalWidth(columns.length, metrics);
  return { columns, columnBreakReasons, columnSegmentIds, columnSegmentSources, metrics, requiredContentWidth };
}

function hasMinorOverflowWrap(layout: VerticalLayoutResult): boolean {
  if (layout.columns.length < 2) {
    return false;
  }
  const tailIndex = layout.columns.length - 1;
  const tailReason = layout.columnBreakReasons[tailIndex] ?? 'wrap';
  if (tailReason !== 'wrap' && tailReason !== 'both') {
    return false;
  }
  const tailGlyphCount = layout.columns[tailIndex]?.glyphs.length ?? 0;
  return tailGlyphCount >= 1 && tailGlyphCount <= minorOverflowMaxGlyphCount;
}

function tryShrinkVerticalForMinorOverflow(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  initialFontSize: number,
  options: BuildVerticalLayoutOptions,
  baseLayout: VerticalLayoutResult,
): { fontSize: number; layout: VerticalLayoutResult } {
  if (!hasMinorOverflowWrap(baseLayout)) {
    return { fontSize: initialFontSize, layout: baseLayout };
  }

  const minAllowedFontSize = Math.max(
    minFontSafetySize,
    Math.ceil(initialFontSize * minorOverflowShrinkMinScale),
  );
  if (initialFontSize <= minAllowedFontSize) {
    return { fontSize: initialFontSize, layout: baseLayout };
  }

  for (let fontSize = initialFontSize - 1; fontSize >= minAllowedFontSize; fontSize -= 1) {
    const candidate = buildVerticalLayout(ctx, text, contentHeight, fontSize, options);
    if (candidate.columns.length < baseLayout.columns.length) {
      return { fontSize, layout: candidate };
    }
  }

  return { fontSize: initialFontSize, layout: baseLayout };
}

function estimateVerticalPreferredProfile(
  ctx: CanvasRenderingContext2D,
  region: TextRegion,
  text: string,
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  preferredColumns?: string[],
): { advanceScale: number; colSpacingScale: number } {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const sw = strokeWidth(fontSize);
  const metrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const sourceColumns = resolveSourceColumns(region);
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const baselineLength = Math.max(1, ...sourceLengths);

  const targetAdvance = contentHeight / baselineLength;
  const baseAdvance = Math.max(1, metrics.defaultAdvanceY * verticalAdvanceTightenRatio);
  const advanceScale = clampNumber(
    targetAdvance / baseAdvance,
    minVerticalAdvanceScale,
    1.1,
  );

  const targetColumnCount = Math.max(
    1,
    sourceColumns.length,
    preferredColumns?.length ?? 0,
    region.originalLineCount ?? 0,
  );
  let colSpacingScale = 1;
  if (targetColumnCount > 1) {
    const rawSpacing = (contentWidth - targetColumnCount * metrics.colWidth) / (targetColumnCount - 1);
    const targetSpacing = Math.max(0, rawSpacing);
    colSpacingScale = clampNumber(
      targetSpacing / Math.max(1, metrics.colSpacing),
      minVerticalColSpacingScale,
      1.2,
    );
  }

  return { advanceScale, colSpacingScale };
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
  options?: VerticalFitOptions,
): number {
  const layout = buildVerticalLayout(measureCtx, text, contentHeight, fontSize, {
    advanceScale: minVerticalAdvanceScale,
    colSpacingScale: minVerticalColSpacingScale,
    preferredColumns: options?.preferredColumns,
  });
  if (options?.targetColumnCount) {
    return Math.max(1, Math.max(layout.columns.length, options.targetColumnCount));
  }
  const columns = layout.columns;
  return Math.max(1, columns.length);
}

function resolveBoxPadding(region: TextRegion): number {
  const minSide = Math.max(1, Math.min(region.box.width, region.box.height));
  // Smaller adaptive margin to improve readability in small bubbles.
  const dynamicPadding = Math.round(minSide * 0.05);
  return Math.max(2, Math.min(dynamicPadding, 6));
}

function resolveOffscreenGuardPadding(fontSize: number): number {
  return Math.max(minOffscreenGuardPaddingPx, Math.round(fontSize * offscreenGuardPaddingByFontRatio));
}

function resolveVerticalContentHeight(contentHeight: number, fontSize: number): number {
  const dynamicRatio = clampNumber(
    verticalContentHeightExpandBaseRatio + fontSize * verticalContentHeightExpandFontRatio,
    0.08,
    0.24,
  );
  const dynamicMax = Math.max(14, Math.round(fontSize * 1.6));
  const extra = clampNumber(
    Math.round(contentHeight * dynamicRatio),
    minVerticalContentHeightExpandPx,
    dynamicMax,
  );
  return contentHeight + extra;
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
  const boxPadding = resolveBoxPadding(expanded);
  const contentWidth = Math.max(20, expanded.box.width - boxPadding * 2);
  const contentHeight = Math.max(20, expanded.box.height - boxPadding * 2);

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
    const neededCols = countNeededColumnsAtFontSize(
      measureCtx,
      text,
      contentHeight,
      initialFontSize,
      {
        targetColumnCount: Math.max(1, expanded.originalLineCount ?? 1),
        preferredColumns: expanded.translatedColumns,
      },
    );
    if (neededCols > usedRowsOrCols) {
      // Vertical columns grow along width (x-axis) in this coordinate frame.
      // Expand around center-x to avoid drifting the translated block to the right.
      const xfact = ((neededCols - usedRowsOrCols) / usedRowsOrCols) + 1;
      const originX = (unrotatedBounds.minX + unrotatedBounds.maxX) / 2;
      const scaledUnrotated = scaleQuadFromOrigin(
        unrotatedQuad,
        xfact,
        1,
        originX,
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
type DrawTypesetOptions = {
  debugMode?: boolean;
  renderText?: boolean;
};

export async function drawTypeset(
  canvas: HTMLCanvasElement,
  regions: TextRegion[],
  targetLang?: string,
  options?: DrawTypesetOptions,
): Promise<HTMLCanvasElement> {
  const debugMode = options?.debugMode === true;
  const renderText = options?.renderText !== false;
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

  for (let regionIndex = 0; regionIndex < renderRegions.length; regionIndex += 1) {
    const inputRegion = renderRegions[regionIndex];
    const translated = inputRegion.translatedText || inputRegion.sourceText;
    const isVerticalInput = inputRegion.direction === "v";
    const preferredColumnSegments = isVerticalInput
      ? resolveVerticalPreferredColumns(inputRegion, translated)
      : undefined;
    const preferredColumns = preferredColumnSegments?.map((segment) => segment.text);
    const preferredColumnSources = preferredColumnSegments?.map((segment) => segment.source);
    if (preferredColumns && preferredColumns.length > 0) {
      inputRegion.translatedColumns = preferredColumns;
    }

    const text = (preferredColumns && preferredColumns.length > 0)
      ? preferredColumns.join("")
      : translated;
    if (!text.trim()) continue;

    const estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(inputRegion)));
    const region = expandRegionBeforeRender(inputRegion, text, measureCtx);
    const boxPadding = resolveBoxPadding(region);
    const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
    const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
    const isVertical = region.direction === "v";
    const verticalContentHeight = isVertical
      ? resolveVerticalContentHeight(contentHeight, estimatedInitialFontSize)
      : contentHeight;
    const colors = resolveColors(region.fgColor, region.bgColor);
    const initialFontSize = estimatedInitialFontSize;
    let debug: RegionTypesetDebug = {
      fittedFontSize: initialFontSize,
      columnBoxes: [],
      columnBreakReasons: [],
      columnSegmentIds: [],
      columnSegmentSources: [],
      offscreenWidth: 0,
      offscreenHeight: 0,
      boxPadding,
      strokePadding: 0,
    };

    let offCanvas: HTMLCanvasElement | null = null;
    let strokePadding: number;

    if (isVertical) {
      const preferredProfile = estimateVerticalPreferredProfile(
        measureCtx,
        region,
        text,
        contentWidth,
        verticalContentHeight,
        initialFontSize,
        region.translatedColumns,
      );
      const verticalLayoutOptions: BuildVerticalLayoutOptions = {
        colSpacingScale: preferredProfile.colSpacingScale,
        advanceScale: preferredProfile.advanceScale,
        preferredColumns: region.translatedColumns,
        preferredColumnSources,
      };
      const verticalResult = (() => {
        const baseLayout = buildVerticalLayout(measureCtx, text, verticalContentHeight, initialFontSize, verticalLayoutOptions);
        const { fontSize, layout } = tryShrinkVerticalForMinorOverflow(
          measureCtx,
          text,
          verticalContentHeight,
          initialFontSize,
          verticalLayoutOptions,
          baseLayout,
        );
        return {
          fontSize,
          columns: layout.columns,
          columnBreakReasons: layout.columnBreakReasons,
          columnSegmentIds: layout.columnSegmentIds,
          columnSegmentSources: layout.columnSegmentSources,
          metrics: layout.metrics,
        };
      })();
      const { fontSize, columns, columnBreakReasons, columnSegmentIds, columnSegmentSources, metrics } = verticalResult;
      strokePadding = resolveVerticalRenderPadding(measureCtx, columns, fontSize, metrics);
      const alignment = resolveAlignment(region, columns.length);
      if (renderText) {
        offCanvas = renderVertical(
          columns,
          fontSize,
          contentWidth,
          verticalContentHeight,
          colors,
          alignment,
          metrics,
          strokePadding,
        );
      }
      debug = {
        fittedFontSize: fontSize,
        columnBoxes: buildVerticalDebugColumnBoxes(
          columns,
          contentWidth,
          verticalContentHeight,
          metrics,
          alignment,
          strokePadding,
        ),
        columnBreakReasons,
        columnSegmentIds,
        columnSegmentSources,
        offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
        offscreenHeight: Math.ceil(verticalContentHeight + strokePadding * 2),
        boxPadding,
        strokePadding,
      };
    } else {
      const horizontalResult = (() => {
        measureCtx.font = `${initialFontSize}px ${fontFamily}`;
        const lines = calcHorizontal(measureCtx, text, contentWidth, initialFontSize);
        return { fontSize: initialFontSize, lines };
      })();
      const { fontSize, lines } = horizontalResult;
      strokePadding = resolveHorizontalRenderPadding(measureCtx, lines, fontSize);
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
        boxPadding,
        strokePadding,
      );
    }

    if (debugMode) {
      drawTypesetDebugOverlay(ctx, inputRegion, region, regionIndex, estimatedInitialFontSize, debug);
    }
  }

  return out;
}
