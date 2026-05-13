import type { TextRegion } from "../../types";

// ---------------------------------------------------------------------------
// Re-export everything from sub-modules
// ---------------------------------------------------------------------------

export * from "./color";
export * from "./geometry";
export * from "./columns";
export * from "./fontFit";

// ---------------------------------------------------------------------------
// Entry function: computeFullVerticalTypeset
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
  preferredColumnSources?: import("./columns").ColumnSegmentSource[];
  sourceColumns: string[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
  initialFontSize: number;
  fittedFontSize: number;
  columns: import("./fontFit").VColumn[];
  columnBreakReasons: import("./fontFit").ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: import("./columns").ColumnSegmentSource[];
  metrics: import("./fontFit").VerticalCellMetrics;
  debugColumnBoxes: import("./fontFit").DebugColumnBox[];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
  contentWidth: number;
  verticalContentHeight: number;
  alignment: "left" | "center" | "right";
};

import { resolveVerticalPreferredColumns, resolveSourceColumns, countTextLength } from "./columns";
import { quadDimensions, getRegionQuad, cloneRegionForTypeset } from "./geometry";
import {
  resolveInitialFontSize,
  resolveBoxPadding,
  resolveVerticalContentHeight,
  estimateVerticalPreferredProfile,
  buildVerticalLayout,
  tryShrinkVerticalForMinorOverflow,
  expandRegionBeforeRender,
  queryMaskMaxY,
  strokeWidth,
  resolveVerticalRenderPadding,
  resolveAlignment,
  buildVerticalDebugColumnBoxes,
  minFontSafetySize,
  type BuildVerticalLayoutOptions,
} from "./fontFit";

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