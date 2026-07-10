/**
 * Count source glyph slots using the same whitespace-free code-point contract
 * as fixture baking. OCR text does not expose grapheme boxes, so this count is
 * intentionally geometry-oriented rather than a language-specific tokenizer.
 */
export function countSourceGeometryGlyphs(text: string): number {
  return Array.from(text.replace(/\s+/gu, "")).length;
}

/**
 * Estimate the visual font size of one vertical source line.
 *
 * The short edge alone is only the detected column width. Capping it by the
 * per-slot inline advance keeps runtime source geometry and baked fixtures on
 * the same semantic contract.
 */
export function estimateVerticalSourceFontSize(
  crossSize: number,
  inlineSize: number,
  glyphCount: number,
  fallbackFontSize: number,
): number {
  const fallback = Number.isFinite(fallbackFontSize) && fallbackFontSize > 0
    ? fallbackFontSize
    : 1;
  const resolvedCrossSize = Number.isFinite(crossSize) && crossSize > 0
    ? crossSize
    : fallback;
  const resolvedInlineAdvance = Number.isFinite(inlineSize) && inlineSize > 0 && glyphCount > 0
    ? inlineSize / glyphCount
    : fallback;
  return Math.max(1, Math.min(resolvedCrossSize, resolvedInlineAdvance));
}
