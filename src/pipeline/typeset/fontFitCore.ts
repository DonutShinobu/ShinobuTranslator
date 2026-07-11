import type { TextRegion, TypesetDebugVerticalItem, TypesetLayoutDiagnostics } from "../../types";
import type { PipelineRenderingContext, PipelineImageData } from "../../runtime/platform";
import { clamp } from "../utils";
import {
  KINSOKU_NSTART,
  KINSOKU_NEND,
  countTextLength,
  countTextGlyphs,
  resolveSourceColumns,
  type ColumnSegmentSource,
  type PreferredColumnSegment,
} from "./columns";
import { segmentVerticalGraphemes, tokenizeVerticalText } from "./verticalOrientation";
import type { VerticalToken } from "./verticalOrientation";
import {
  quadAngle,
  cloneRegionForTypeset,
  getRegionQuad,
  quadCenter,
  quadDimensions,
  rotateQuad,
  quadBounds,
  scaleQuadFromOrigin,
  updateRegionGeometryFromQuad,
} from "./geometry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const verticalAdvanceTightenRatio = 1.0;
export const verticalColumnSpacingRatio = 0.1;
export const minVerticalAdvanceScale = 0.75;
export const minSourceGeometryAdvanceScale = 0.6;
export const sourceGeometryActualBoxScale = 0.65;
export const sourceGeometryAdvanceQuantizationBiasPx = 0.15;
export const minVerticalColSpacingScale = 0.5;
export const verticalContentHeightExpandBaseRatio = 0.007;
export const verticalContentHeightExpandFontRatio = 0.0;
export const minVerticalContentHeightExpandPx = 0;
export const minFontSafetySize = 8;
export const minorOverflowMaxGlyphCount = 2;
export const minorOverflowShrinkMinScale = 0.8;
export const minOffscreenGuardPaddingPx = 8;
export const offscreenGuardPaddingByFontRatio = 0.35;
export const minHorizontalLetterSpacingScale = 0.85;
export const maxHorizontalLetterSpacingScale = 1.5;
export const minHorizontalLineHeightScale = 0.85;
export const maxSourceGeometryAnchorAngleRad = 0.052;
export const maxVerticalSourceColumnOverlapRatio = 0.45;
export const minSidewaysLatinOpticalScale = 0.85;
export const maxSidewaysLatinOpticalScale = 1.2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerticalGlyph = VerticalToken & {
  ch: string;
  advanceY: number;
  renderInlineScale: number;
  renderCrossScale: number;
  renderOffsetX: number;
  renderOffsetY: number;
  inkWidth: number;
  inkHeight: number;
  boundaryGap: number;
};

export type VerticalTokenMetrics = Pick<
  VerticalGlyph,
  | "advanceY"
  | "renderInlineScale"
  | "renderCrossScale"
  | "renderOffsetX"
  | "renderOffsetY"
  | "inkWidth"
  | "inkHeight"
  | "boundaryGap"
>;

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
  perColumnAdvanceScale?: (columnIndex: number) => number | undefined;
  actualBoxScale?: number;
  useDefaultAdvanceBase?: boolean;
  columnAnchor?: VerticalColumnAnchor;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
  perColumnMaxHeight?: (columnIndex: number) => number;
};

export type ColumnBreakReason = 'start' | 'model' | 'wrap' | 'both';

// ---------------------------------------------------------------------------
// Horizontal line types
// ---------------------------------------------------------------------------

export type HLine = {
  text: string;
  width: number;
};

export type HorizontalFromLinesResult = {
  lines: HLine[];
  lineBreakReasons: ColumnBreakReason[];
  lineSegmentIds: number[];
  lineSegmentSources: ColumnSegmentSource[];
};

// ---------------------------------------------------------------------------
// Horizontal layout constants
// ---------------------------------------------------------------------------

export const horizontalLetterSpacingRatio = -0.05;
export const horizontalLineHeightRatio = 0.93;

export type VerticalLayoutResult = {
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  requiredContentWidth: number;
};

export type DebugColumnBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VerticalColumnAnchor = {
  contentCenterX: number;
};

export type VerticalColumnPositions = {
  totalWidth: number;
  groupLeftX: number;
  groupCenterX: number;
  firstCenterX: number;
  centers: number[];
};

export type VerticalSourceGeometryProfile = {
  columnCount: number;
  groupCenterX: number;
  /** Robust source em estimate from per-column cross size and inline advance. */
  sourceFontSize: number;
  /** Resolved column-center pitch; falls back to the normal em-based pitch for one source column. */
  sourcePitch: number;
  medianPitch: number | null;
  medianGap: number | null;
  medianWidth: number;
  medianHeight: number;
  medianAdvance: number;
  /**
   * Advance and top-edge targets are aligned to source text/render column order.
   * Spatial pitch and anchor are resolved independently from right-to-left order.
   */
  perColumnAdvance: number[];
  perColumnTopY: number[];
};

export type RegionTypesetDebug = {
  fittedFontSize: number;
  columnBoxes: DebugColumnBox[];
  columnGlyphCenters?: Array<Array<{ ch: string; x: number; y: number }>>;
  columnVerticalItems?: TypesetDebugVerticalItem[][];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  layoutDiagnostics?: TypesetLayoutDiagnostics;
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
    perColumnAdvanceScale?: number[];
    colSpacingScale: number;
  };
};

// ---------------------------------------------------------------------------
// Utility wrappers
// ---------------------------------------------------------------------------

export function clampNumber(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

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
  ctx: PipelineRenderingContext,
  ch: string,
  fallbackFontSize: number,
): { width: number; height: number } {
  const metrics = ctx.measureText(ch);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? Math.abs(metrics.actualBoundingBoxLeft!) : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? Math.abs(metrics.actualBoundingBoxRight!) : 0;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? Math.abs(metrics.actualBoundingBoxAscent!) : 0;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? Math.abs(metrics.actualBoundingBoxDescent!) : 0;

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

type TextInkMetrics = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

function measureTextInkMetrics(
  ctx: PipelineRenderingContext,
  text: string,
  fallbackFontSize: number,
): TextInkMetrics {
  const metrics = ctx.measureText(text);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft)
    ? metrics.actualBoundingBoxLeft!
    : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight)
    ? metrics.actualBoundingBoxRight!
    : 0;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent!
    : 0;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent!
    : 0;
  const measuredWidth = left + right;
  const measuredHeight = ascent + descent;
  const hasHorizontalInkBounds = measuredWidth > 0;
  const hasVerticalInkBounds = measuredHeight > 0;

  return {
    width: hasHorizontalInkBounds
      ? measuredWidth
      : Math.max(1, metrics.width || fallbackFontSize),
    height: hasVerticalInkBounds
      ? measuredHeight
      : fallbackFontSize,
    centerX: hasHorizontalInkBounds ? (right - left) / 2 : 0,
    centerY: hasVerticalInkBounds ? (descent - ascent) / 2 : 0,
  };
}

/**
 * Estimate vertical advance from font metrics.
 * In browsers we do not have FreeType's vertAdvance, so use font box / em box.
 */
export function resolveFontVerticalAdvance(
  ctx: PipelineRenderingContext,
  fontSize: number,
): number {
  const metrics = ctx.measureText('国');
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent ?? 0) + metricAbs(metrics.fontBoundingBoxDescent ?? 0);
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
  ctx: PipelineRenderingContext,
  ch: string,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  actualBoxScale?: number,
  useDefaultAdvanceBase = false,
): number {
  const metrics = ctx.measureText(ch);
  const fontBox = metricAbs(metrics.fontBoundingBoxAscent ?? 0) + metricAbs(metrics.fontBoundingBoxDescent ?? 0);
  const actualBox = metricAbs(metrics.actualBoundingBoxAscent ?? 0) + metricAbs(metrics.actualBoundingBoxDescent ?? 0);
  const glyphAdvanceBase = fontBox > 0
    ? fontBox
    : defaultAdvanceY;
  const baseAdvance = useDefaultAdvanceBase ? defaultAdvanceY : glyphAdvanceBase;
  const stabilizedAdvance = Math.max(baseAdvance, fontSize * 0.9);
  const resolvedAdvance = stabilizedAdvance * verticalAdvanceTightenRatio * advanceScale;

  const resolvedActualBoxScale = actualBoxScale ?? Math.max(advanceScale, minVerticalAdvanceScale);
  const scaledActualBox = actualBox * resolvedActualBoxScale;
  const advance = Math.max(scaledActualBox, resolvedAdvance);
  const quantizedAdvance = useDefaultAdvanceBase
    ? advance - sourceGeometryAdvanceQuantizationBiasPx
    : advance;
  return Math.max(1, Math.round(quantizedAdvance));
}

export function resolveVerticalTokenMetrics(
  ctx: PipelineRenderingContext,
  token: VerticalToken,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  actualBoxScale?: number,
  useDefaultAdvanceBase = false,
): VerticalTokenMetrics {
  const ink = measureTextInkMetrics(ctx, token.displayText, fontSize);
  const renderOffsetX = ink.centerX === 0 ? 0 : -ink.centerX;
  const renderOffsetY = ink.centerY === 0 ? 0 : -ink.centerY;
  if (token.kind !== "sideways-run") {
    const measureText = token.kind === "tate-chu-yoko" ? "国" : token.displayText;
    return {
      advanceY: resolveGlyphVerticalAdvance(
        ctx,
        measureText,
        fontSize,
        defaultAdvanceY,
        advanceScale,
        actualBoxScale,
        useDefaultAdvanceBase,
      ),
      renderInlineScale: 1,
      renderCrossScale: 1,
      renderOffsetX: 0,
      renderOffsetY: 0,
      inkWidth: ink.width,
      inkHeight: ink.height,
      boundaryGap: 0,
    };
  }

  const isLatinRun = token.sourceGlyphCount > 1
    && segmentVerticalGraphemes(token.sourceText).every((grapheme) =>
      /^\p{Script=Latin}\p{M}*$/u.test(grapheme),
    );
  const referenceInk = measureTextInkMetrics(ctx, "国", fontSize);
  const targetLatinCrossSize = Math.max(
    referenceInk.width,
    Math.min(fontSize, defaultAdvanceY * advanceScale),
  );
  const renderCrossScale = isLatinRun
    ? clampNumber(
        targetLatinCrossSize / Math.max(1, ink.height),
        minSidewaysLatinOpticalScale,
        maxSidewaysLatinOpticalScale,
      )
    : 1;

  if (token.sourceGlyphCount === 1) {
    const advanceY = resolveGlyphVerticalAdvance(
      ctx,
      token.displayText,
      fontSize,
      defaultAdvanceY,
      advanceScale,
      actualBoxScale,
      useDefaultAdvanceBase,
    );
    return {
      advanceY,
      renderInlineScale: Math.min(1, advanceY / Math.max(1, ink.width)),
      renderCrossScale,
      renderOffsetX,
      renderOffsetY,
      inkWidth: ink.width,
      inkHeight: ink.height,
      boundaryGap: 0,
    };
  }

  const boundaryGap = isLatinRun
    ? Math.max(0, (defaultAdvanceY * advanceScale - referenceInk.height) / 2)
    : 0;
  const inlineScale = renderCrossScale * (isLatinRun ? 1 : advanceScale);
  const scaledInkWidth = ink.width * inlineScale;
  const unquantizedAdvance = scaledInkWidth + boundaryGap * 2;
  const quantizedAdvance = useDefaultAdvanceBase
    ? unquantizedAdvance - sourceGeometryAdvanceQuantizationBiasPx
    : unquantizedAdvance;
  const advanceY = Math.max(1, Math.round(quantizedAdvance));
  const availableInkWidth = Math.max(1, advanceY - boundaryGap * 2);
  return {
    advanceY,
    renderInlineScale: availableInkWidth / Math.max(1, ink.width),
    renderCrossScale,
    renderOffsetX,
    renderOffsetY,
    inkWidth: ink.width,
    inkHeight: ink.height,
    boundaryGap,
  };
}

/**
 * Resolve per-cell metrics for vertical layout based on real glyph bounds.
 */
export function resolveVerticalCellMetrics(
  ctx: PipelineRenderingContext,
  text: string,
  fontSize: number,
  sw: number,
): VerticalCellMetrics {
  const items = tokenizeVerticalText(text);
  let maxGlyphWidth = 0;

  for (const item of items) {
    if (item.kind === "sideways-run" || item.kind === "tate-chu-yoko") {
      maxGlyphWidth = Math.max(maxGlyphWidth, fontSize);
      continue;
    }
    const box = measureGlyphBox(ctx, item.displayText, fontSize);
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

function medianNumber(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return null;
  }
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) {
    return finite[middle];
  }
  return (finite[middle - 1] + finite[middle]) / 2;
}

function normalizeGeometryText(text: string): string {
  return text.replace(/\s+/g, "");
}

function isRightToLeftGeometryOrder(
  lines: NonNullable<TextRegion["sourceLineGeometries"]>,
): boolean {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].centerX > lines[index - 1].centerX + 1e-6) {
      return false;
    }
  }
  return true;
}

function resolveSourceOrderedGeometryLines(
  region: TextRegion,
  sourceLines: NonNullable<TextRegion["sourceLineGeometries"]>,
  targetColumnCount: number,
): NonNullable<TextRegion["sourceLineGeometries"]> {
  const sourceColumns = resolveSourceColumns(region).map(normalizeGeometryText);
  if (sourceColumns.length !== targetColumnCount) {
    return [];
  }

  const lineTexts = sourceLines.map((line) => normalizeGeometryText(line.text));
  const directMatch = sourceColumns.every((text, index) => text === lineTexts[index]);
  if (directMatch) {
    return isRightToLeftGeometryOrder(sourceLines) ? sourceLines : [];
  }

  const buckets = new Map<string, NonNullable<TextRegion["sourceLineGeometries"]>>();
  for (const line of sourceLines) {
    const key = normalizeGeometryText(line.text);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(line);
    } else {
      buckets.set(key, [line]);
    }
  }

  const matched = sourceColumns.map((text) => {
    const bucket = buckets.get(text);
    return bucket?.length === 1 ? bucket[0] : undefined;
  });

  if (!matched.every((line): line is NonNullable<typeof line> => line !== undefined)) {
    return [];
  }

  return isRightToLeftGeometryOrder(matched)
    ? matched
    : [];
}

export function resolveVerticalColumnPositions(
  columnCount: number,
  contentWidth: number,
  metrics: VerticalCellMetrics,
  padding: number = 0,
  anchor?: VerticalColumnAnchor,
): VerticalColumnPositions {
  const totalWidth = computeVerticalTotalWidth(columnCount, metrics);
  let contentCenterX = anchor?.contentCenterX ?? contentWidth / 2;
  if (anchor && totalWidth > 0 && totalWidth <= contentWidth) {
    contentCenterX = clampNumber(
      contentCenterX,
      totalWidth / 2,
      contentWidth - totalWidth / 2,
    );
  }
  const groupCenterX = padding + contentCenterX;
  const groupLeftX = groupCenterX - totalWidth / 2;
  const firstCenterX = groupLeftX + totalWidth - metrics.colWidth / 2;
  const centers = Array.from({ length: Math.max(0, columnCount) }, (_, index) =>
    firstCenterX - index * (metrics.colWidth + metrics.colSpacing),
  );

  return {
    totalWidth,
    groupLeftX,
    groupCenterX,
    firstCenterX,
    centers,
  };
}

export function resolveVerticalSourceGeometryProfile(
  region: TextRegion,
  targetColumnCount: number,
): VerticalSourceGeometryProfile | undefined {
  const sourceLines = (region.sourceLineGeometries ?? [])
    .filter((line) =>
      line.direction === "v" &&
      Number.isFinite(line.centerX) &&
      Number.isFinite(line.centerY) &&
      Number.isFinite(line.width) &&
      Number.isFinite(line.height) &&
      line.width > 0 &&
      line.height > 0,
    );

  if (
    targetColumnCount <= 0 ||
    sourceLines.length === 0 ||
    sourceLines.length !== targetColumnCount
  ) {
    return undefined;
  }

  const spatialColumns = [...sourceLines].sort((a, b) => b.centerX - a.centerX);
  const widths = spatialColumns.map((line) => line.width);
  const heights = spatialColumns.map((line) => line.height);
  const medianWidth = medianNumber(widths);
  const medianHeight = medianNumber(heights);
  if (medianWidth === null || medianHeight === null) {
    return undefined;
  }

  const pitches: number[] = [];
  const gaps: number[] = [];
  for (let index = 0; index < spatialColumns.length - 1; index += 1) {
    const right = spatialColumns[index];
    const left = spatialColumns[index + 1];
    const pitch = right.centerX - left.centerX;
    if (!Number.isFinite(pitch) || pitch <= 1) {
      continue;
    }
    pitches.push(pitch);
    gaps.push(pitch - (right.width + left.width) / 2);
  }

  const measuredMedianPitch = pitches.length > 0 ? medianNumber(pitches) : null;
  const measuredMedianGap = gaps.length > 0 ? medianNumber(gaps) : null;
  const medianPitch = measuredMedianPitch;
  const medianGap = measuredMedianGap;

  const leftEdge = Math.min(...spatialColumns.map((line) => line.centerX - line.width / 2));
  const rightEdge = Math.max(...spatialColumns.map((line) => line.centerX + line.width / 2));
  const sourceColumnStyles = spatialColumns.map((line) => {
    const glyphCount = countTextGlyphs(line.text);
    const effectiveGlyphCount = Math.max(1, glyphCount);
    const advance = line.height / effectiveGlyphCount;
    const declaredFontSize = line.fontSize;
    const crossSize = declaredFontSize !== undefined && Number.isFinite(declaredFontSize) && declaredFontSize > 0
      ? Math.min(line.width, declaredFontSize)
      : line.width;
    return {
      glyphCount,
      advance,
      fontSize: Math.min(crossSize, advance),
    };
  });
  const reliableSourceColumnStyles = sourceColumnStyles.filter((style) => style.glyphCount >= 2);
  const fontSizeCandidates = reliableSourceColumnStyles.length > 0
    ? reliableSourceColumnStyles
    : sourceColumnStyles;
  const sourceFontSize = medianNumber(fontSizeCandidates.map((style) => style.fontSize));
  if (sourceFontSize === null || sourceFontSize <= 0) {
    return undefined;
  }
  const medianAdvance = reliableSourceColumnStyles.length > 0
    ? medianNumber(reliableSourceColumnStyles.map((style) => style.advance)) ?? sourceFontSize
    : sourceFontSize;
  const sourcePitch = medianPitch !== null
    ? Math.max(sourceFontSize, medianPitch)
    : sourceFontSize * (1 + verticalColumnSpacingRatio);
  const sourceOrderedLines = resolveSourceOrderedGeometryLines(region, sourceLines, targetColumnCount);
  const perColumnAdvance = sourceOrderedLines.map((line) => {
    const glyphCount = countTextGlyphs(line.text);
    return glyphCount >= 2
      ? line.height / glyphCount
      : medianAdvance;
  });
  const perColumnTopY = sourceOrderedLines.map((line) => line.centerY - line.height / 2);

  return {
    columnCount: spatialColumns.length,
    groupCenterX: (leftEdge + rightEdge) / 2,
    sourceFontSize,
    sourcePitch,
    medianPitch,
    medianGap,
    medianWidth,
    medianHeight,
    medianAdvance,
    perColumnAdvance,
    perColumnTopY,
  };
}

export function resolveVerticalSourceColumnAnchor(
  region: TextRegion,
  boxPadding: number,
  profile?: VerticalSourceGeometryProfile,
): VerticalColumnAnchor | undefined {
  if (!profile) {
    return undefined;
  }
  const angle = quadAngle(getRegionQuad(region));
  if (Math.abs(angle) > maxSourceGeometryAnchorAngleRad) {
    return undefined;
  }
  const contentCenterX = profile.groupCenterX - region.box.x - boxPadding;
  if (!Number.isFinite(contentCenterX)) {
    return undefined;
  }
  return { contentCenterX };
}

export function resolveVerticalSourceColumnStartOffsets(
  region: TextRegion,
  boxPadding: number,
  renderedColumnCount: number,
  profile?: VerticalSourceGeometryProfile,
): number[] | undefined {
  if (
    renderedColumnCount <= 1 ||
    !profile ||
    profile.perColumnTopY.length !== renderedColumnCount
  ) {
    return undefined;
  }

  const angle = quadAngle(getRegionQuad(region));
  if (Math.abs(angle) > maxSourceGeometryAnchorAngleRad) {
    return undefined;
  }

  const contentTopY = region.box.y + boxPadding;
  const offsets = profile.perColumnTopY.map((topY) => topY - contentTopY);
  if (!offsets.every(Number.isFinite)) {
    return undefined;
  }

  return offsets.map((offset) => Math.max(0, offset));
}

// ---------------------------------------------------------------------------
// Vertical calc
// ---------------------------------------------------------------------------

/**
 * Split text into columns for vertical rendering.
 * Characters flow top-to-bottom within a column; new columns start to the left.
 * Applies Unicode vertical-orientation tokens and kinsoku rules.
 */
export function calcVertical(
  ctx: PipelineRenderingContext,
  text: string,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
  actualBoxScale?: number,
  useDefaultAdvanceBase = false,
  perColumnAdvanceScale?: (columnIndex: number) => number | undefined,
): VColumn[] {
  const tokens = tokenizeVerticalText(text);
  if (tokens.length === 0) return [];

  const advanceCache = new Map<string, VerticalTokenMetrics>();
  const getTokenMetrics = (
    token: VerticalToken,
    columnIndex: number,
  ): VerticalTokenMetrics => {
    const columnAdvanceScale = perColumnAdvanceScale?.(columnIndex) ?? advanceScale;
    const cacheKey = `${columnAdvanceScale}:${token.kind}:${token.displayText}`;
    const cached = advanceCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveVerticalTokenMetrics(
      ctx,
      token,
      fontSize,
      defaultAdvanceY,
      columnAdvanceScale,
      actualBoxScale,
      useDefaultAdvanceBase,
    );
    advanceCache.set(cacheKey, resolved);
    return resolved;
  };

  const columns: VColumn[] = [];
  let col: VerticalGlyph[] = [];
  let colHeight = 0;
  let colIndex = 0;

  for (const token of tokens) {
    const tokenMetrics = getTokenMetrics(token, colIndex);
    const glyph: VerticalGlyph = {
      ...token,
      ch: token.displayText,
      ...tokenMetrics,
    };

    const currentMaxHeight = perColumnMaxHeight ? perColumnMaxHeight(colIndex) : maxHeight;
    if (colHeight + glyph.advanceY > currentMaxHeight && col.length > 0) {
      // Check kinsoku: next char can't start a column
      const firstSourceChar = Array.from(token.sourceText)[0] ?? token.sourceText;
      if (KINSOKU_NSTART.has(firstSourceChar)) {
        col.push(glyph);
        colHeight += glyph.advanceY;
        columns.push({ glyphs: col, height: colHeight });
        col = [];
        colHeight = 0;
        colIndex++;
        continue;
      }

      // Current col's last char can't end a column
      const lastInCol = col[col.length - 1];
      const lastSourceChars = Array.from(lastInCol.sourceText);
      const lastSourceChar = lastSourceChars[lastSourceChars.length - 1] ?? lastInCol.sourceText;
      if (KINSOKU_NEND.has(lastSourceChar) && col.length > 1) {
        const carry = col.pop()!;
        columns.push({ glyphs: col, height: colHeight - carry.advanceY });
        col = [carry, glyph];
        colHeight = carry.advanceY + glyph.advanceY;
        colIndex++;
        continue;
      }

      columns.push({ glyphs: col, height: colHeight });
      col = [];
      colHeight = 0;
      colIndex++;
    }

    col.push(glyph);
    colHeight += glyph.advanceY;
  }

  if (col.length > 0) {
    columns.push({ glyphs: col, height: colHeight });
  }
  return columns;
}

export function calcVerticalFromColumns(
  ctx: PipelineRenderingContext,
  preferredColumns: string[],
  preferredColumnSources: ColumnSegmentSource[] | undefined,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
  actualBoxScale?: number,
  useDefaultAdvanceBase = false,
  perColumnAdvanceScale?: (columnIndex: number) => number | undefined,
): {
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
} {
  const sourceGlyphCount = (column: VColumn): number =>
    column.glyphs.reduce((sum, glyph) => sum + glyph.sourceGlyphCount, 0);
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
      const mergedGlyphCount = sourceGlyphCount(previous) + sourceGlyphCount(current);
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
      actualBoxScale,
      useDefaultAdvanceBase,
      perColumnAdvanceScale ? (ci) => perColumnAdvanceScale(columns.length + ci) : undefined,
    );
    const segmentMaxGlyphCount = Math.max(1, ...segmentColumns.map(sourceGlyphCount));
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
// Horizontal calc helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains Latin word characters (needs word-level wrapping).
 */
function hasLatinWords(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
}

/**
 * Measure horizontal text width with per-char letterSpacing.
 */
function measureHorizontalTextWidth(
  ctx: PipelineRenderingContext,
  text: string,
  letterSpacing: number,
): number {
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }

  if (chars.length === 1) {
    return ctx.measureText(chars[0]).width;
  }

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
 * CJK character-level horizontal line breaking with kinsoku shori.
 */
function calcHorizontalCjkSegment(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  letterSpacing: number,
): HLine[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: HLine[] = [];
  let line = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const trial = line + ch;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, letterSpacing);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // Line is full -- push current line, but apply kinsoku rules
    if (line.length > 0) {
      const lastChar = line[line.length - 1];
      const nextChar = ch;

      // If next char can't start a line, keep it on current line
      if (KINSOKU_NSTART.has(nextChar) && line.length > 0) {
        line += ch;
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
        line = "";
        continue;
      }

      // If current line's last char can't end a line, move it to next line
      if (KINSOKU_NEND.has(lastChar) && line.length > 1) {
        const carry = line[line.length - 1];
        line = line.slice(0, -1);
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
        line = carry + ch;
        continue;
      }

      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
    }
    line = ch;
  }

  if (line) {
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
  }
  return lines;
}

/**
 * Latin word-level horizontal line breaking. Falls back to character-level for long words.
 */
function calcHorizontalLatinSegment(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  letterSpacing: number,
): HLine[] {
  const words = text.split(/\s+/);
  const lines: HLine[] = [];
  let line = "";

  for (const word of words) {
    const trial = line ? line + " " + word : word;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, letterSpacing);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // If current line is non-empty, push it
    if (line) {
      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
      line = "";
    }

    // Check if the word itself exceeds maxWidth -- character-break it
    if (measureHorizontalTextWidth(ctx, word, letterSpacing) > maxWidth) {
      const chars = [...word];
      let frag = "";
      for (const ch of chars) {
        const fragTrial = frag + ch;
        if (measureHorizontalTextWidth(ctx, fragTrial, letterSpacing) > maxWidth && frag) {
          lines.push({ text: frag, width: measureHorizontalTextWidth(ctx, frag, letterSpacing) });
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
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, letterSpacing) });
  }
  return lines;
}

/**
 * Wrap a single text segment into horizontal lines based on maxWidth.
 * Dispatches to CJK or Latin line-breaking depending on content.
 */
function wrapHorizontalSegment(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  letterSpacing: number,
): HLine[] {
  const cleaned = text.replace(/\n+/g, " ").trim();
  if (!cleaned) return [];

  if (hasLatinWords(cleaned)) {
    return calcHorizontalLatinSegment(ctx, cleaned, maxWidth, letterSpacing);
  }
  return calcHorizontalCjkSegment(ctx, cleaned, maxWidth, letterSpacing);
}

/**
 * Split preferred line segments into horizontal lines with break-reason tracking.
 * Analogous to calcVerticalFromColumns but for horizontal layout.
 *
 * For each preferred line segment (from LLM), try to fit it as a single line.
 * If the segment width exceeds maxWidth, apply word/character wrapping.
 * Tracks break reasons, segment IDs, and segment sources.
 */
export function calcHorizontalFromLines(
  ctx: PipelineRenderingContext,
  preferredLines: PreferredColumnSegment[],
  maxWidth: number,
  fontSize: number,
  letterSpacingScale = 1,
): HorizontalFromLinesResult {
  const letterSpacing = fontSize * horizontalLetterSpacingRatio * letterSpacingScale;

  const mergeSegmentLinesByMaxCharCount = (
    segmentLines: HLine[],
    segmentMaxCharCount: number,
  ): HLine[] => {
    if (segmentLines.length <= 1) {
      return segmentLines;
    }
    const merged: HLine[] = [];
    for (let i = 0; i < segmentLines.length; i += 1) {
      const current = segmentLines[i];
      const previous = merged[merged.length - 1];
      if (!previous) {
        merged.push(current);
        continue;
      }
      const mergedCharCount = [...previous.text].length + [...current.text].length;
      const mergedWidth = measureHorizontalTextWidth(
        ctx,
        previous.text + current.text,
        letterSpacing,
      );
      const canMergeBySameSegmentMax = mergedCharCount <= segmentMaxCharCount;
      if (canMergeBySameSegmentMax && mergedWidth <= maxWidth) {
        previous.text += current.text;
        previous.width = mergedWidth;
        continue;
      }
      merged.push(current);
    }
    return merged;
  };

  const lines: HLine[] = [];
  const lineBreakReasons: ColumnBreakReason[] = [];
  const lineSegmentIds: number[] = [];
  const lineSegmentSources: ColumnSegmentSource[] = [];
  let hasOutput = false;
  let previousSegmentOverflowed = false;
  let segmentIndex = 0;

  for (const source of preferredLines) {
    const segment = source.text.trim();
    if (!segment) {
      continue;
    }
    segmentIndex += 1;
    const segmentSource = source.source;
    const segmentLines = wrapHorizontalSegment(ctx, segment, maxWidth, letterSpacing);
    const segmentMaxCharCount = Math.max(1, ...segmentLines.map((line) => [...line.text].length));

    if (segmentLines.length === 0) {
      previousSegmentOverflowed = false;
      continue;
    }

    const canFollowPrevious = hasOutput
      && lines.length > 0
      && (previousSegmentOverflowed || segmentSource === 'split');
    if (canFollowPrevious) {
      const lastLine = lines[lines.length - 1];
      const firstLine = segmentLines[0];
      // Try to append the first segment line to the previous output line
      const combined = lastLine.text + firstLine.text;
      const combinedWidth = measureHorizontalTextWidth(ctx, combined, letterSpacing);
      if (combinedWidth <= maxWidth) {
        lastLine.text = combined;
        lastLine.width = combinedWidth;
        segmentLines.shift();
      }
    }

    const balancedSegmentLines = mergeSegmentLinesByMaxCharCount(segmentLines, segmentMaxCharCount);

    for (let i = 0; i < balancedSegmentLines.length; i += 1) {
      lines.push(balancedSegmentLines[i]);
      lineSegmentIds.push(segmentIndex);
      lineSegmentSources.push(segmentSource);
      if (!hasOutput && i === 0) {
        lineBreakReasons.push('start');
        hasOutput = true;
        continue;
      }
      if (i === 0) {
        lineBreakReasons.push(canFollowPrevious ? 'both' : 'model');
        hasOutput = true;
        continue;
      }
      lineBreakReasons.push('wrap');
    }

    previousSegmentOverflowed = balancedSegmentLines.length > 1;
  }

  return { lines, lineBreakReasons, lineSegmentIds, lineSegmentSources };
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
  ctx: PipelineRenderingContext,
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
      const left = metricAbs(measured.actualBoundingBoxLeft ?? 0);
      const right = metricAbs(measured.actualBoundingBoxRight ?? 0);
      const ascent = metricAbs(measured.actualBoundingBoxAscent ?? 0);
      const descent = metricAbs(measured.actualBoundingBoxDescent ?? 0);

      const halfAdvance = glyph.advanceY / 2;
      const xOverflow = glyph.kind === "sideways-run"
        ? Math.max(
            0,
            glyph.inkHeight * glyph.renderCrossScale / 2 - halfColWidth,
          )
        : Math.max(0, left - halfColWidth, right - halfColWidth);
      const yOverflow = glyph.kind === "sideways-run"
        ? Math.max(
            0,
            glyph.inkWidth * glyph.renderInlineScale / 2 - halfAdvance,
          )
        : Math.max(0, ascent - halfAdvance, descent - halfAdvance);
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
  sourceStartOffset?: number,
): number {
  if (sourceStartOffset !== undefined && Number.isFinite(sourceStartOffset)) {
    const maxOffset = Math.max(0, contentHeight - columnHeight);
    return padding + clampNumber(sourceStartOffset, 0, maxOffset);
  }
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
  ctx?: PipelineRenderingContext,
  fontSize?: number,
  anchor?: VerticalColumnAnchor,
  columnStartOffsets?: readonly number[],
): DebugColumnBox[] {
  if (columns.length === 0) {
    return [];
  }
  const positions = resolveVerticalColumnPositions(columns.length, contentWidth, metrics, padding, anchor);

  const boxes: DebugColumnBox[] = [];
  for (let c = 0; c < columns.length; c += 1) {
    const col = columns[c];
    const cx = positions.centers[c];
    const startY = resolveVerticalStartY(
      contentHeight,
      col.height,
      alignment,
      padding,
      columnStartOffsets?.[c],
    );
    let boxWidth = metrics.colWidth;
    if (ctx && fontSize) {
      let maxW = 0;
      for (const g of col.glyphs) {
        const visualWidth = g.kind === "sideways-run"
          ? g.inkHeight * g.renderCrossScale
          : measureGlyphBox(ctx, g.ch, fontSize).width;
        maxW = Math.max(maxW, visualWidth);
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
// Font size fitting
// ---------------------------------------------------------------------------

/**
 * Find the largest font size for vertical text that fits within content area.
 */
export function buildVerticalLayout(
  ctx: PipelineRenderingContext,
  text: string,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
  options?: BuildVerticalLayoutOptions,
): VerticalLayoutResult {
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const sw = strokeWidth(fontSize);
  const baseMetrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const colSpacingScale = options?.colSpacingScale ?? 1;
  const advanceScale = options?.advanceScale ?? 1;
  const perColumnAdvanceScale = options?.perColumnAdvanceScale;
  const actualBoxScale = options?.actualBoxScale;
  const useDefaultAdvanceBase = options?.useDefaultAdvanceBase ?? false;
  const scaledColSpacing = baseMetrics.colSpacing * colSpacingScale;
  const minColSpacing = -baseMetrics.colWidth * maxVerticalSourceColumnOverlapRatio;
  const metrics = {
    ...baseMetrics,
    colSpacing: Math.round(clampNumber(scaledColSpacing, minColSpacing, Number.MAX_SAFE_INTEGER)),
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
      actualBoxScale,
      useDefaultAdvanceBase,
      perColumnAdvanceScale,
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
      actualBoxScale,
      useDefaultAdvanceBase,
      perColumnAdvanceScale,
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
  const tailGlyphCount = layout.columns[tailIndex]?.glyphs.reduce(
    (sum, glyph) => sum + glyph.sourceGlyphCount,
    0,
  ) ?? 0;
  return tailGlyphCount >= 1 && tailGlyphCount <= minorOverflowMaxGlyphCount;
}

export function tryShrinkVerticalForMinorOverflow(
  ctx: PipelineRenderingContext,
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

/**
 * Try to eliminate a minor horizontal overflow by shrinking font size 1px at a time.
 * Analogous to tryShrinkVerticalForMinorOverflow but for horizontal text.
 *
 * Detects when the last line has only 1-2 overflow characters and tries
 * progressively smaller font sizes until the text fits in fewer lines.
 */
export function tryShrinkHorizontalForMinorOverflow(
  ctx: PipelineRenderingContext,
  text: string,
  contentWidth: number,
  initialFontSize: number,
  fontFamily: string,
  baseLines: HLine[],
  calcLines: (ctx: PipelineRenderingContext, text: string, maxWidth: number, fontSize: number) => HLine[],
): { fontSize: number; lines: HLine[] } {
  // Check for minor overflow: last line has only 1-2 characters
  if (baseLines.length < 2) {
    return { fontSize: initialFontSize, lines: baseLines };
  }
  const tailLine = baseLines[baseLines.length - 1];
  const tailCharCount = [...tailLine.text].length;
  if (tailCharCount < 1 || tailCharCount > minorOverflowMaxGlyphCount) {
    return { fontSize: initialFontSize, lines: baseLines };
  }

  const minAllowedFontSize = Math.max(
    minFontSafetySize,
    Math.ceil(initialFontSize * minorOverflowShrinkMinScale),
  );
  if (initialFontSize <= minAllowedFontSize) {
    return { fontSize: initialFontSize, lines: baseLines };
  }

  for (let fontSize = initialFontSize - 1; fontSize >= minAllowedFontSize; fontSize -= 1) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    const candidate = calcLines(ctx, text, contentWidth, fontSize);
    if (candidate.length < baseLines.length) {
      return { fontSize, lines: candidate };
    }
  }

  return { fontSize: initialFontSize, lines: baseLines };
}

export function estimateVerticalPreferredProfile(
  ctx: PipelineRenderingContext,
  region: TextRegion,
  text: string,
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
  preferredColumns?: string[],
  originalContentWidth?: number,
  sourceGeometryProfile?: VerticalSourceGeometryProfile,
): { advanceScale: number; perColumnAdvanceScale?: number[]; colSpacingScale: number } {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const sw = strokeWidth(fontSize);
  const metrics = resolveVerticalCellMetrics(ctx, text, fontSize, sw);
  const sourceColumns = resolveSourceColumns(region);
  const translatedColumnTexts = preferredColumns ?? [text];
  const baseAdvance = Math.max(1, metrics.defaultAdvanceY * verticalAdvanceTightenRatio);
  const sourceStyleScale = sourceGeometryProfile
    ? fontSize / Math.max(1, sourceGeometryProfile.sourceFontSize)
    : 1;

  let advanceScale: number;
  let perColumnAdvanceScale: number[] | undefined;
  if (sourceGeometryProfile) {
    const targetAdvance = sourceGeometryProfile.medianAdvance * sourceStyleScale;
    advanceScale = targetAdvance / baseAdvance;

    const sourceColumnIdentityMatches = (
      sourceGeometryProfile.perColumnAdvance.length === sourceColumns.length &&
      translatedColumnTexts.length === sourceColumns.length &&
      translatedColumnTexts.every((column, index) =>
        normalizeGeometryText(column) === normalizeGeometryText(sourceColumns[index] ?? ""),
      )
    );
    if (sourceColumnIdentityMatches) {
      perColumnAdvanceScale = sourceGeometryProfile.perColumnAdvance.map((sourceAdvance) =>
        sourceAdvance * sourceStyleScale / baseAdvance,
      );
    }
  } else {
    const sourceLengths = sourceColumns.map((column) => countTextGlyphs(column));
    const translatedLengths = translatedColumnTexts.map((column) => countTextGlyphs(column));
    const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);
    const targetAdvance = contentHeight / baselineLength;
    advanceScale = clampNumber(
      targetAdvance / baseAdvance,
      minVerticalAdvanceScale,
      1.1,
    );
  }

  const targetColumnCount = Math.max(
    1,
    sourceColumns.length,
    preferredColumns?.length ?? 0,
    region.originalLineCount ?? 0,
  );
  let colSpacingScale = 1;
  if (targetColumnCount > 1) {
    const spacingWidth = originalContentWidth ?? contentWidth;
    const fallbackSpacing = (spacingWidth - targetColumnCount * metrics.colWidth) / (targetColumnCount - 1);
    const sourcePitch = sourceGeometryProfile
      ? sourceGeometryProfile.sourcePitch * sourceStyleScale
      : undefined;
    const sourceSpacing = sourcePitch !== undefined ? sourcePitch - metrics.colWidth : undefined;
    const baseSpacing = Math.max(1, metrics.colSpacing);
    if (sourceSpacing !== undefined) {
      const minSourceSpacing = -metrics.colWidth * maxVerticalSourceColumnOverlapRatio;
      const maxSourceSpacing = metrics.colWidth * 2.5;
      const targetSpacing = clampNumber(sourceSpacing, minSourceSpacing, maxSourceSpacing);
      colSpacingScale = clampNumber(
        targetSpacing / baseSpacing,
        minSourceSpacing / baseSpacing,
        maxSourceSpacing / baseSpacing,
      );
    } else {
      const targetSpacing = Math.max(0, fallbackSpacing);
      colSpacingScale = clampNumber(
        targetSpacing / baseSpacing,
        minVerticalColSpacingScale,
        2.5,
      );
    }
  }

  return { advanceScale, perColumnAdvanceScale, colSpacingScale };
}

export function estimateHorizontalPreferredProfile(
  ctx: PipelineRenderingContext,
  region: TextRegion,
  text: string,
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  fontFamily: string,
  preferredLines?: string[],
  originalContentHeight?: number,
): { letterSpacingScale: number; lineHeightScale: number } {
  ctx.font = `${fontSize}px ${fontFamily}`;

  // Measure total text width with default letterSpacing ratio
  const defaultLetterSpacing = fontSize * -0.05;
  const chars = [...text.replace(/\n+/g, ' ').trim()];
  let totalTextWidth = 0;
  for (let i = 0; i < chars.length; i++) {
    totalTextWidth += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) {
      totalTextWidth += defaultLetterSpacing;
    }
  }
  totalTextWidth = Math.max(0, totalTextWidth);

  // Estimate how many lines are needed at default spacing
  const neededLineCount = Math.max(1, Math.ceil(totalTextWidth / contentWidth));
  const targetLineCount = Math.max(
    1,
    region.originalLineCount ?? 0,
    preferredLines?.length ?? 0,
  );

  if (neededLineCount <= targetLineCount) {
    return { letterSpacingScale: 1, lineHeightScale: 1 };
  }

  // Compress letter spacing: when letterSpacingRatio is negative, scaling it
  // UP increases overlap and compresses line width. We need total text to fit
  // into targetLineCount lines of contentWidth. Scale the ratio so that the
  // tighter spacing absorbs the overflow.
  const totalCapacity = contentWidth * targetLineCount;
  const letterSpacingScale = totalTextWidth > totalCapacity
    ? clampNumber(totalTextWidth / totalCapacity, 1, maxHorizontalLetterSpacingScale)
    : 1;

  // Compress line height: how much shorter must each line be to fit
  // targetLineCount lines in available height
  const defaultLineHeight = Math.max(1, Math.round(fontSize * 0.93));
  const availableHeight = originalContentHeight ?? contentHeight;
  const maxTotalLineHeight = availableHeight;
  const targetTotalLineHeight = defaultLineHeight * targetLineCount;
  const lineHeightScale = targetTotalLineHeight > maxTotalLineHeight
    ? clampNumber(maxTotalLineHeight / targetTotalLineHeight, minHorizontalLineHeightScale, 1)
    : 1;

  return { letterSpacingScale, lineHeightScale };
}

// ---------------------------------------------------------------------------
// Region geometry — layout helpers
// ---------------------------------------------------------------------------

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

/**
 * Resolve content height for horizontal layout with stroke overflow compensation.
 * Same logic as resolveVerticalContentHeight — adds a small amount of extra
 * height so that text stroke pixels at the bottom edge are not clipped.
 */
export function resolveHorizontalContentHeight(contentHeight: number, fontSize: number): number {
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

/**
 * Compute the maximum content height available for horizontal layout
 * based on the bubble mask. If the bubble extends below the region box,
 * we can use the additional vertical space to accommodate more lines.
 *
 * If no bubble mask is available, returns `contentHeight` unchanged.
 */
export function resolveHorizontalMaskHeight(
  bubbleMask: PipelineImageData | undefined,
  region: TextRegion,
  contentHeight: number,
  fontSize: number,
): number {
  if (!bubbleMask) {
    return contentHeight;
  }

  const boxPadding = resolveBoxPadding(region);
  const sw = strokeWidth(fontSize);
  const safetyMargin = sw + 2;

  // The horizontal extent of the region in image coordinates.
  // For horizontal text we query the full width of the region.
  const boxTop = region.box.y + boxPadding;
  const boxLeft = region.box.x + boxPadding;
  const boxRight = region.box.x + region.box.width - boxPadding;

  // Find how far down the bubble extends within the region's horizontal extent.
  const maskMaxY = queryMaskMaxY(bubbleMask, boxLeft, boxRight, boxTop);

  // The mask allows content to extend from boxTop down to maskMaxY.
  const maskContentHeight = Math.max(0, maskMaxY - boxTop - safetyMargin);

  return Math.max(contentHeight, maskContentHeight);
}

export function countNeededRowsAtFontSize(
  measureCtx: PipelineRenderingContext,
  text: string,
  contentWidth: number,
  fontSize: number,
  calcHorizontalLineCount: (ctx: PipelineRenderingContext, text: string, maxWidth: number, fontSize: number) => number,
): number {
  return Math.max(1, calcHorizontalLineCount(measureCtx, text, contentWidth, fontSize));
}

export function countNeededColumnsAtFontSize(
  measureCtx: PipelineRenderingContext,
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
  mask: PipelineImageData,
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

export function expandRegionBeforeRender(
  region: TextRegion,
  text: string,
  measureCtx: PipelineRenderingContext,
  fontFamily: string,
  calcHorizontalLineCount: (ctx: PipelineRenderingContext, text: string, maxWidth: number, fontSize: number) => number,
): TextRegion {
  const expanded = cloneRegionForTypeset(region);
  const initialFontSize = resolveInitialFontSize(expanded);
  let targetFontSize = initialFontSize;
  expanded.fontSize = targetFontSize;

  const usedRowsOrCols = Math.max(1, expanded.originalLineCount ?? 1);
  const boxPadding = resolveBoxPadding(expanded);
  // Use quad real dimensions (edge lengths) instead of AABB (box.width/height).
  // For tilted quads the AABB is inflated, causing incorrect layout decisions.
  const expandedQuadDims = quadDimensions(getRegionQuad(expanded));
  const contentWidth = Math.max(20, expandedQuadDims.width - boxPadding * 2);
  const contentHeight = Math.max(20, expandedQuadDims.height - boxPadding * 2);

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
