import type { TextRegion } from "../../types";

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
  ["“", "﹁"], // LEFT DOUBLE QUOTATION MARK
  ["”", "﹂"], // RIGHT DOUBLE QUOTATION MARK
  ["‘", "﹁"], // LEFT SINGLE QUOTATION MARK
  ["’", "﹂"], // RIGHT SINGLE QUOTATION MARK
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

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

export type ColumnSegmentSource = 'model' | 'split';

export type PreferredColumnSegment = {
  text: string;
  source: ColumnSegmentSource;
};

// ---------------------------------------------------------------------------
// Column splitting
// ---------------------------------------------------------------------------

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