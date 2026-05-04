import type { TextRegion, QuadPoint } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const verticalAdvanceTightenRatio = 1.0;
export const verticalColumnSpacingRatio = 0.1;
export const minVerticalAdvanceScale = 0.75;
export const minVerticalColSpacingScale = 0.5;
export const verticalContentHeightExpandBaseRatio = 0.007;
export const verticalContentHeightExpandFontRatio = 0.0;
export const minVerticalContentHeightExpandPx = 0;
export const minFontSafetySize = 8;
export const minorOverflowMaxGlyphCount = 2;
export const minorOverflowShrinkMinScale = 0.8;
export const minOffscreenGuardPaddingPx = 8;
export const offscreenGuardPaddingByFontRatio = 0.35;

// ---------------------------------------------------------------------------
// CJK Maps
// ---------------------------------------------------------------------------

/**
 * CJK horizontal-to-vertical punctuation substitution map.
 * Ported from manga-image-translator's CJK_H2V table.
 */
export const CJK_H2V = new Map<string, string>([
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
  ["“", "﹁"], // "
  ["”", "﹂"], // "
  ["‘", "﹁"], // '
  ["’", "﹂"], // '
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
export const KINSOKU_NSTART = new Set([
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
export const KINSOKU_NEND = new Set([
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
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
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
export function colorDistance(
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

export type ResolvedColors = {
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
export function resolveColors(
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
export const halfWidthKana = new Set(["っ", "ッ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]);

/**
 * Count text length where small kana characters count as 0.5 and all others
 * count as 1.0. Used for comparing source vs translated text length.
 */
export function countTextLength(text: string): number {
  let length = 0;
  for (const ch of text.trim()) {
    length += halfWidthKana.has(ch) ? 0.5 : 1;
  }
  return length;
}

export function charLength(ch: string): number {
  return halfWidthKana.has(ch) ? 0.5 : 1;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function splitColumns(text: string): string[] {
  return text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function splitByTextLength(text: string, maxLength: number): { kept: string; overflow: string } {
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

export function resolveSourceColumns(region: TextRegion): string[] {
  const fromText = splitColumns(region.sourceText);
  if (fromText.length > 0) {
    return fromText;
  }
  const fallback = region.sourceText.trim();
  return fallback ? [fallback] : [];
}

export function resolveTranslatedColumns(region: TextRegion, translatedText: string): PreferredColumnSegment[] {
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

// ---------------------------------------------------------------------------
// Column rebalancing
// ---------------------------------------------------------------------------

export function rebalanceVerticalColumns(
  sourceColumns: string[],
  translatedColumns: PreferredColumnSegment[],
): {
  columns: PreferredColumnSegment[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
} {
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const baselineLength = Math.max(1, ...sourceLengths);
  const normalizedTranslated = translatedColumns
    .map((column) => ({ text: column.text.trim(), source: column.source }))
    .filter((column) => column.text.length > 0);

  if (normalizedTranslated.length === 0) {
    return {
      columns: [],
      sourceColumnLengths: sourceLengths,
      singleColumnMaxLength: sourceLengths.length > 0 ? baselineLength : null,
    };
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

  return {
    columns: output.filter((column) => column.text.trim().length > 0),
    sourceColumnLengths: sourceLengths,
    singleColumnMaxLength: sourceLengths.length > 0 ? baselineLength : null,
  };
}

export type VerticalPreferredColumnsResult = {
  columns: PreferredColumnSegment[];
  sourceColumns: string[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
};

export function resolveVerticalPreferredColumns(region: TextRegion, translatedText: string): VerticalPreferredColumnsResult {
  const sourceColumns = resolveSourceColumns(region);
  const translatedColumns = resolveTranslatedColumns(region, translatedText);
  if (translatedColumns.length === 0) {
    return {
      columns: [],
      sourceColumns,
      sourceColumnLengths: sourceColumns.map((column) => countTextLength(column)),
      singleColumnMaxLength: sourceColumns.length > 0
        ? Math.max(...sourceColumns.map((column) => countTextLength(column)))
        : null,
    };
  }
  const balanced = rebalanceVerticalColumns(sourceColumns, translatedColumns);
  return {
    columns: balanced.columns,
    sourceColumns,
    sourceColumnLengths: balanced.sourceColumnLengths,
    singleColumnMaxLength: balanced.singleColumnMaxLength,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerticalGlyph = {
  ch: string;
  advanceY: number;
};

export type VColumn = {
  glyphs: VerticalGlyph[];
  height: number;
};

export type VerticalCellMetrics = {
  colWidth: number;
  defaultAdvanceY: number;
  colSpacing: number;
};

export type BuildVerticalLayoutOptions = {
  colSpacingScale?: number;
  advanceScale?: number;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
  perColumnMaxHeight?: (columnIndex: number) => number;
};

export type VerticalLayoutResult = {
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  requiredContentWidth: number;
};

export type ColumnBreakReason = 'start' | 'model' | 'wrap' | 'both';
export type ColumnSegmentSource = 'model' | 'split';

export type PreferredColumnSegment = {
  text: string;
  source: ColumnSegmentSource;
};

export type DebugColumnBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionTypesetDebug = {
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

export type VerticalFitOptions = {
  targetColumnCount?: number;
  preferredColumns?: string[];
  preferredProfile?: {
    advanceScale: number;
    colSpacingScale: number;
  };
};

export type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

// ---------------------------------------------------------------------------
// Font size resolution
// ---------------------------------------------------------------------------

/**
 * Determine the initial font size for a region.
 * Prefers region.fontSize (from OCR/merge), falls back to box-based heuristic.
 */
export function resolveInitialFontSize(region: TextRegion): number {
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
// Font/glyph functions
// ---------------------------------------------------------------------------

/**
 * Measure a single glyph's visual bounds.
 * Prefer TextMetrics actual bounding boxes; fall back to width/fontSize.
 */
export function measureGlyphBox(
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

export function metricAbs(value: number): number {
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

/**
 * Estimate vertical advance from font metrics.
 * In browsers we do not have FreeType's vertAdvance, so use font box / em box.
 */
export function resolveFontVerticalAdvance(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
): number {
  const metrics = ctx.measureText('国');
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent) + metricAbs(metrics.fontBoundingBoxDescent);
  const resolved = fontBox > 0
    ? fontBox
    : fontSize;
  return Math.max(1, Math.ceil(Math.max(resolved, fontSize)));
}

/**
 * Estimate per-glyph vertical advance as an approximation of FreeType vertAdvance.
 * Keeps spacing stable while allowing smaller visual glyphs to consume less height.
 */
export function resolveGlyphVerticalAdvance(
  ctx: CanvasRenderingContext2D,
  ch: string,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
): number {
  const metrics = ctx.measureText(ch);
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent) + metricAbs(metrics.fontBoundingBoxDescent);
  const actualBox = metricAbs(metrics.actualBoundingBoxAscent) + metricAbs(metrics.actualBoundingBoxDescent);
  const baseAdvance = fontBox > 0
    ? fontBox
    : defaultAdvanceY;
  const stabilizedAdvance = Math.max(baseAdvance, fontSize * 0.9);
  const resolvedAdvance = stabilizedAdvance * verticalAdvanceTightenRatio * advanceScale;

  const scaledActualBox = actualBox * Math.max(advanceScale, minVerticalAdvanceScale);
  return Math.max(1, Math.round(Math.max(scaledActualBox, resolvedAdvance)));
}

/**
 * Resolve per-cell metrics for vertical layout based on real glyph bounds.
 */
export function resolveVerticalCellMetrics(
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
  const safetyPadding = Math.max(1, Math.ceil(sw * 0.5));
  const colWidth = Math.ceil(Math.max(fontSize * 1.1, maxGlyphWidth + safetyPadding));
  const colSpacing = Math.max(1, Math.round(fontSize * verticalColumnSpacingRatio));

  return { colWidth, defaultAdvanceY, colSpacing };
}

export function computeVerticalTotalWidth(columnCount: number, metrics: VerticalCellMetrics): number {
  if (columnCount <= 0) {
    return 0;
  }
  return columnCount * metrics.colWidth + Math.max(0, columnCount - 1) * metrics.colSpacing;
}

// ---------------------------------------------------------------------------
// Vertical calc
// ---------------------------------------------------------------------------

/**
 * Split text into columns for vertical rendering.
 * Characters flow top-to-bottom within a column; new columns start to the left.
 * Applies CJK_H2V punctuation substitution and kinsoku rules.
 */
export function calcVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
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
  let colIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const raw = chars[i];
    const ch = CJK_H2V.get(raw) ?? raw;
    const advanceY = getAdvance(ch);

    const currentMaxHeight = perColumnMaxHeight ? perColumnMaxHeight(colIndex) : maxHeight;
    if (colHeight + advanceY > currentMaxHeight && col.length > 0) {
      // Check kinsoku: next char can't start a column
      if (KINSOKU_NSTART.has(ch)) {
        col.push({ ch, advanceY });
        colHeight += advanceY;
        columns.push({ glyphs: col, height: colHeight });
        col = [];
        colHeight = 0;
        colIndex++;
        continue;
      }

      // Current col's last char can't end a column
      const lastInCol = col[col.length - 1];
      if (KINSOKU_NEND.has(lastInCol.ch) && col.length > 1) {
        const carry = col.pop()!;
        columns.push({ glyphs: col, height: colHeight - carry.advanceY });
        col = [carry, { ch, advanceY }];
        colHeight = carry.advanceY + advanceY;
        colIndex++;
        continue;
      }

      columns.push({ glyphs: col, height: colHeight });
      col = [];
      colHeight = 0;
      colIndex++;
    }

    col.push({ ch, advanceY });
    colHeight += advanceY;
  }

  if (col.length > 0) {
    columns.push({ glyphs: col, height: colHeight });
  }
  return columns;
}

export function calcVerticalFromColumns(
  ctx: CanvasRenderingContext2D,
  preferredColumns: string[],
  preferredColumnSources: ColumnSegmentSource[] | undefined,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
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
      perColumnMaxHeight ? (ci) => perColumnMaxHeight(columns.length + ci) : undefined,
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
        const currentColMaxHeight = perColumnMaxHeight ? perColumnMaxHeight(columns.length - 1) : maxHeight;
        if (lastColumn.height + glyph.advanceY > currentColMaxHeight) {
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
// Stroke/padding
// ---------------------------------------------------------------------------

/**
 * Stroke width adaptive to font size (7% of fontSize, minimum 1px).
 * Ported from manga-image-translator: stroke_radius = 64 * max(int(0.07 * font_size), 1)
 */
export function strokeWidth(fontSize: number): number {
  return Math.max(1, Math.round(fontSize * 0.07));
}

export function resolveOffscreenGuardPadding(fontSize: number): number {
  return Math.max(minOffscreenGuardPaddingPx, Math.round(fontSize * offscreenGuardPaddingByFontRatio));
}

export function resolveVerticalRenderPadding(
  ctx: CanvasRenderingContext2D,
  columns: VColumn[],
  fontSize: number,
  metrics: VerticalCellMetrics,
  fontFamily: string,
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

// ---------------------------------------------------------------------------
// Vertical layout build
// ---------------------------------------------------------------------------

export function resolveVerticalStartY(
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

export function buildVerticalDebugColumnBoxes(
  columns: VColumn[],
  contentWidth: number,
  contentHeight: number,
  metrics: VerticalCellMetrics,
  alignment: "left" | "center" | "right",
  padding: number,
  ctx?: CanvasRenderingContext2D,
  fontSize?: number,
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
    let boxWidth = metrics.colWidth;
    if (ctx && fontSize) {
      let maxW = 0;
      for (const g of col.glyphs) {
        const box = measureGlyphBox(ctx, g.ch, fontSize);
        maxW = Math.max(maxW, box.width);
      }
      boxWidth = Math.ceil(Math.max(fontSize * 1.1, maxW));
    }
    boxes.push({
      x: cx - boxWidth / 2,
      y: startY,
      width: boxWidth,
      height: col.height,
    });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Alignment resolution
// ---------------------------------------------------------------------------

/**
 * Determine text alignment for a region.
 * Ported from manga-image-translator's TextBlock.alignment property.
 */
export function resolveAlignment(
  region: TextRegion,
  lineCount: number,
): "left" | "center" | "right" {
  if (lineCount <= 1) return "center";
  if (region.direction === "v") return "left"; // top-aligned in vertical
  return "center";
}

// ---------------------------------------------------------------------------
// Quad helpers
// ---------------------------------------------------------------------------

/**
 * Compute rotation angle from quad's top edge.
 * Returns angle in radians.
 */
export function quadAngle(quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]): number {
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
}

/**
 * Compute the width and height of the quad (from its edges).
 */
export function quadDimensions(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): { width: number; height: number } {
  const topW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const botW = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const leftH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const rightH = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  return { width: (topW + botW) / 2, height: (leftH + rightH) / 2 };
}

export function mapOffscreenPointToCanvas(
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
  const s = Math.min(sx, sy);
  const localX = (point.x - offscreenWidth / 2) * s;
  const localY = (point.y - offscreenHeight / 2) * s;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  };
}

export function mapOffscreenRectToCanvasQuad(
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

// ---------------------------------------------------------------------------
// Font size fitting
// ---------------------------------------------------------------------------

/**
 * Find the largest font size for vertical text that fits within content area.
 */
export function buildVerticalLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
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
      options.perColumnMaxHeight,
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
      options?.perColumnMaxHeight,
    );
    columnBreakReasons = columns.map((_, index) => (index === 0 ? 'start' : 'wrap'));
    columnSegmentIds = columns.map(() => 1);
    columnSegmentSources = columns.map(() => 'model');
  }
  const requiredContentWidth = computeVerticalTotalWidth(columns.length, metrics);
  return { columns, columnBreakReasons, columnSegmentIds, columnSegmentSources, metrics, requiredContentWidth };
}

export function hasMinorOverflowWrap(layout: VerticalLayoutResult): boolean {
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

export function tryShrinkVerticalForMinorOverflow(
  ctx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  initialFontSize: number,
  options: BuildVerticalLayoutOptions,
  baseLayout: VerticalLayoutResult,
  fontFamily: string,
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
    const candidate = buildVerticalLayout(ctx, text, contentHeight, fontSize, fontFamily, options);
    if (candidate.columns.length < baseLayout.columns.length) {
      return { fontSize, layout: candidate };
    }
  }

  return { fontSize: initialFontSize, layout: baseLayout };
}

export function estimateVerticalPreferredProfile(
  ctx: CanvasRenderingContext2D,
  region: TextRegion,
  text: string,
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
  preferredColumns?: string[],
): { advanceScale: number; colSpacingScale: number } {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const sw = strokeWidth(fontSize);
  const metrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const sourceColumns = resolveSourceColumns(region);
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const translatedColumnTexts = preferredColumns ?? [text];
  const translatedLengths = translatedColumnTexts.map((c) => countTextLength(c));
  const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);

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
      2.5,
    );
  }

  return { advanceScale, colSpacingScale };
}

// ---------------------------------------------------------------------------
// Region geometry
// ---------------------------------------------------------------------------

export function cloneQuad(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: quad[0].x, y: quad[0].y },
    { x: quad[1].x, y: quad[1].y },
    { x: quad[2].x, y: quad[2].y },
    { x: quad[3].x, y: quad[3].y },
  ];
}

export function cloneRegionForTypeset(region: TextRegion): TextRegion {
  return {
    ...region,
    box: { ...region.box },
    quad: region.quad ? cloneQuad(region.quad) : undefined,
  };
}

export function boxToQuad(region: TextRegion): Quad {
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

export function getRegionQuad(region: TextRegion): Quad {
  if (region.quad) {
    return cloneQuad(region.quad);
  }
  return boxToQuad(region);
}

export function quadCenter(quad: Quad): { x: number; y: number } {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

export function rotatePoint(point: QuadPoint, cx: number, cy: number, angle: number): QuadPoint {
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

export function rotateQuad(quad: Quad, cx: number, cy: number, angle: number): Quad {
  return [
    rotatePoint(quad[0], cx, cy, angle),
    rotatePoint(quad[1], cx, cy, angle),
    rotatePoint(quad[2], cx, cy, angle),
    rotatePoint(quad[3], cx, cy, angle),
  ];
}

export function quadBounds(quad: Quad): { minX: number; minY: number; maxX: number; maxY: number } {
  const minX = Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const minY = Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const maxX = Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const maxY = Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  return { minX, minY, maxX, maxY };
}

export function scaleQuadFromOrigin(
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

export function updateRegionGeometryFromQuad(region: TextRegion, quad: Quad): void {
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

export function countNeededRowsAtFontSize(
  measureCtx: CanvasRenderingContext2D,
  text: string,
  contentWidth: number,
  fontSize: number,
  calcHorizontalLineCount: (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number) => number,
): number {
  return Math.max(1, calcHorizontalLineCount(measureCtx, text, contentWidth, fontSize));
}

export function countNeededColumnsAtFontSize(
  measureCtx: CanvasRenderingContext2D,
  text: string,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
  options?: VerticalFitOptions,
): number {
  const layout = buildVerticalLayout(measureCtx, text, contentHeight, fontSize, fontFamily, {
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

export function queryMaskMaxY(
  mask: ImageData,
  xStart: number,
  xEnd: number,
  yStart: number,
): number {
  const clampedXStart = Math.max(0, Math.round(xStart));
  const clampedXEnd = Math.min(mask.width - 1, Math.round(xEnd));
  const maxY = mask.height - 1;

  if (clampedXStart > clampedXEnd || yStart > maxY) {
    return Math.round(yStart);
  }

  let lastValidY = Math.round(yStart);
  for (let y = Math.round(yStart); y <= maxY; y++) {
    let allOutside = true;
    for (let x = clampedXStart; x <= clampedXEnd; x++) {
      const idx = (y * mask.width + x) * 4;
      if (mask.data[idx + 3] > 0) {
        allOutside = false;
        break;
      }
    }
    if (allOutside) {
      return lastValidY;
    }
    lastValidY = y;
  }
  return lastValidY;
}

export function resolveBoxPadding(_region: TextRegion): number {
  return 0;
}

export function resolveVerticalContentHeight(contentHeight: number, fontSize: number): number {
  const dynamicRatio = clampNumber(
    verticalContentHeightExpandBaseRatio + fontSize * verticalContentHeightExpandFontRatio,
    0.0,
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

export function expandRegionBeforeRender(
  region: TextRegion,
  text: string,
  measureCtx: CanvasRenderingContext2D,
  fontFamily: string,
  calcHorizontalLineCount: (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number) => number,
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
    const neededRows = countNeededRowsAtFontSize(measureCtx, text, contentWidth, initialFontSize, calcHorizontalLineCount);
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
      fontFamily,
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
// computeFullVerticalTypeset — shared by typeset.ts and benchmark
// ---------------------------------------------------------------------------

export type FullVerticalTypesetInput = {
  region: TextRegion;
  fontFamily: string;
  measureCtx: CanvasRenderingContext2D;
};

export type FullVerticalTypesetResult = {
  expandedRegion: TextRegion;
  text: string;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
  sourceColumns: string[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
  initialFontSize: number;
  fittedFontSize: number;
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  debugColumnBoxes: DebugColumnBox[];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
  contentWidth: number;
  verticalContentHeight: number;
  alignment: "left" | "center" | "right";
};

export function computeFullVerticalTypeset(
  input: FullVerticalTypesetInput,
): FullVerticalTypesetResult {
  const { region: inputRegion, fontFamily: ff, measureCtx } = input;

  const translatedRaw = inputRegion.translatedText;
  const translated = translatedRaw || inputRegion.sourceText;

  const verticalPreferred = resolveVerticalPreferredColumns(inputRegion, translated);
  const preferredColumnSegments = verticalPreferred?.columns;
  const preferredColumns = preferredColumnSegments?.map((segment) => segment.text);
  const preferredColumnSources = preferredColumnSegments?.map((segment) => segment.source);

  const cloned = cloneRegionForTypeset(inputRegion);
  if (preferredColumns && preferredColumns.length > 0) {
    cloned.translatedColumns = preferredColumns;
  }

  const text = (preferredColumns && preferredColumns.length > 0)
    ? preferredColumns.join("")
    : translated;

  const sourceColumns = verticalPreferred?.sourceColumns ?? resolveSourceColumns(inputRegion);
  const sourceColumnLengths = verticalPreferred?.sourceColumnLengths ?? sourceColumns.map((column) => countTextLength(column));
  const singleColumnMaxLength = verticalPreferred?.singleColumnMaxLength
    ?? (sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null);

  let estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(cloned)));

  // Use quad's real dimensions (edge lengths) instead of AABB so that
  // the layout space matches the actual rendering target.  When the quad
  // is tilted its AABB is larger than the true width/height, which would
  // cause the offscreen canvas to be oversized and then get scaled down
  // during compositing, shrinking the rendered text.
  const clonedQuadDims = quadDimensions(getRegionQuad(cloned));

  if (singleColumnMaxLength && singleColumnMaxLength > 0) {
    const boxPaddingEst = resolveBoxPadding(cloned);
    const availableHeight = Math.max(20, clonedQuadDims.height - boxPaddingEst * 2);
    const maxFontByHeight = Math.round(availableHeight / singleColumnMaxLength);
    if (maxFontByHeight > 0 && maxFontByHeight < estimatedInitialFontSize) {
      estimatedInitialFontSize = Math.max(8, maxFontByHeight);
    }
  }

  const estColumnCount = Math.max(
    1,
    sourceColumns.length,
    preferredColumns?.length ?? 0,
    cloned.originalLineCount ?? 0,
  );
  if (estColumnCount > 1) {
    const boxPaddingEst = resolveBoxPadding(cloned);
    const availableWidth = Math.max(20, clonedQuadDims.width - boxPaddingEst * 2);
    const maxFontByWidth = Math.floor(availableWidth / (estColumnCount * 1.05));
    if (maxFontByWidth > 0 && maxFontByWidth < estimatedInitialFontSize) {
      estimatedInitialFontSize = Math.max(8, maxFontByWidth);
    }
  }

  const noopHLineCount = () => 1;
  const region = expandRegionBeforeRender(cloned, text, measureCtx, ff, noopHLineCount);

  const boxPadding = resolveBoxPadding(region);
  const regionQuadDims = quadDimensions(getRegionQuad(region));
  const contentWidth = Math.max(20, regionQuadDims.width - boxPadding * 2);
  const contentHeight = Math.max(20, regionQuadDims.height - boxPadding * 2);
  let verticalContentHeight = resolveVerticalContentHeight(contentHeight, estimatedInitialFontSize);

  const preferredProfile = estimateVerticalPreferredProfile(
    measureCtx,
    region,
    text,
    contentWidth,
    verticalContentHeight,
    estimatedInitialFontSize,
    ff,
    region.translatedColumns,
  );

  const verticalLayoutOptions: BuildVerticalLayoutOptions = {
    colSpacingScale: preferredProfile.colSpacingScale,
    advanceScale: preferredProfile.advanceScale,
    preferredColumns: region.translatedColumns,
    preferredColumnSources,
  };

  const targetColumnCount = Math.max(
    1,
    sourceColumns.length,
    preferredColumns?.length ?? 0,
    inputRegion.originalLineCount ?? 0,
  );

  const baseLayout = buildVerticalLayout(measureCtx, text, verticalContentHeight, estimatedInitialFontSize, ff, verticalLayoutOptions);
  let { fontSize, layout } = tryShrinkVerticalForMinorOverflow(
    measureCtx,
    text,
    verticalContentHeight,
    estimatedInitialFontSize,
    verticalLayoutOptions,
    baseLayout,
    ff,
  );

  let effectiveContentHeight = verticalContentHeight;
  let perColumnMaxHeight: ((columnIndex: number) => number) | undefined;

  if (layout.columns.length > targetColumnCount && inputRegion.bubbleMask) {
    const mask = inputRegion.bubbleMask;
    const boxTop = region.box.y + boxPadding;
    const boxLeft = region.box.x + boxPadding;
    const sw = strokeWidth(estimatedInitialFontSize);
    const safetyMargin = sw + 2;

    const totalColW = layout.columns.length * layout.metrics.colWidth
      + Math.max(0, layout.columns.length - 1) * layout.metrics.colSpacing;
    const offsetX = (contentWidth - totalColW) / 2;
    const colStartX = offsetX + totalColW - layout.metrics.colWidth / 2;

    const perColMaxHeights: number[] = [];
    for (let c = 0; c < layout.columns.length; c++) {
      const localCx = colStartX - c * (layout.metrics.colWidth + layout.metrics.colSpacing);
      const colHalfW = layout.metrics.colWidth / 2 + sw;
      const imageXStart = boxLeft + localCx - colHalfW;
      const imageXEnd = boxLeft + localCx + colHalfW;
      const maskMaxY = queryMaskMaxY(mask, imageXStart, imageXEnd, boxTop);
      perColMaxHeights.push(Math.max(verticalContentHeight, maskMaxY - boxTop - safetyMargin));
    }

    effectiveContentHeight = Math.max(verticalContentHeight, ...perColMaxHeights);
    perColumnMaxHeight = (ci: number) => perColMaxHeights[ci] ?? verticalContentHeight;

    const extendedProfile = estimateVerticalPreferredProfile(
      measureCtx, region, text, contentWidth, effectiveContentHeight,
      estimatedInitialFontSize, ff, region.translatedColumns,
    );
    const extendedOptions: BuildVerticalLayoutOptions = {
      ...verticalLayoutOptions,
      colSpacingScale: extendedProfile.colSpacingScale,
      advanceScale: extendedProfile.advanceScale,
      perColumnMaxHeight,
    };
    const extendedLayout = buildVerticalLayout(
      measureCtx, text, effectiveContentHeight, estimatedInitialFontSize, ff, extendedOptions,
    );
    const shrunk = tryShrinkVerticalForMinorOverflow(
      measureCtx, text, effectiveContentHeight, estimatedInitialFontSize,
      extendedOptions, extendedLayout, ff,
    );
    fontSize = shrunk.fontSize;
    layout = shrunk.layout;
    verticalLayoutOptions.perColumnMaxHeight = perColumnMaxHeight;
  }

  if (layout.columns.length > targetColumnCount && fontSize > minFontSafetySize) {
    const minAllowed = Math.max(minFontSafetySize, Math.ceil(estimatedInitialFontSize * 0.3));
    let lo = minAllowed;
    let hi = fontSize - 1;
    let bestFs = fontSize;
    let bestLayout = layout;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const profile = estimateVerticalPreferredProfile(
        measureCtx, region, text, contentWidth, effectiveContentHeight, mid, ff, region.translatedColumns,
      );
      const opts: BuildVerticalLayoutOptions = {
        ...verticalLayoutOptions,
        colSpacingScale: profile.colSpacingScale,
        advanceScale: profile.advanceScale,
        perColumnMaxHeight,
      };
      const candidate = buildVerticalLayout(measureCtx, text, effectiveContentHeight, mid, ff, opts);
      if (candidate.columns.length <= targetColumnCount) {
        bestFs = mid;
        bestLayout = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestFs !== fontSize) {
      fontSize = bestFs;
      layout = bestLayout;
    }
  }

  const { columns, columnBreakReasons, columnSegmentIds, columnSegmentSources, metrics } = layout;
  const strokePadding = resolveVerticalRenderPadding(measureCtx, columns, fontSize, metrics, ff);
  const alignment = resolveAlignment(region, columns.length);

  measureCtx.font = `${fontSize}px ${ff}`;
  const debugColumnBoxes = buildVerticalDebugColumnBoxes(
    columns,
    contentWidth,
    effectiveContentHeight,
    metrics,
    alignment,
    strokePadding,
    measureCtx,
    fontSize,
  );

  return {
    expandedRegion: region,
    text,
    preferredColumns: preferredColumns && preferredColumns.length > 0 ? preferredColumns : undefined,
    preferredColumnSources,
    sourceColumns,
    sourceColumnLengths,
    singleColumnMaxLength,
    initialFontSize: estimatedInitialFontSize,
    fittedFontSize: fontSize,
    columns,
    columnBreakReasons,
    columnSegmentIds,
    columnSegmentSources,
    metrics,
    debugColumnBoxes,
    offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
    offscreenHeight: Math.ceil(effectiveContentHeight + strokePadding * 2),
    boxPadding,
    strokePadding,
    contentWidth,
    verticalContentHeight: effectiveContentHeight,
    alignment,
  };
}
