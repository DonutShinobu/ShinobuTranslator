import type { TextRegion, TypesetLayoutDiagnostics } from "../../types";
import type { PipelineRenderingContext } from "../../runtime/platform";

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
  measureCtx: PipelineRenderingContext;
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
  columnAnchor?: import("./fontFit").VerticalColumnAnchor;
  layoutDiagnostics: TypesetLayoutDiagnostics;
};

import { resolveVerticalPreferredColumns, resolveSourceColumns, countTextLength, countTextGlyphs } from "./columns";
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
  resolveVerticalColumnPositions,
  resolveVerticalSourceColumnAnchor,
  resolveVerticalSourceGeometryProfile,
  minFontSafetySize,
  sourceGeometryActualBoxScale,
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

  const heightFitLength = Math.max(
    singleColumnMaxLength ?? 0,
    ...sourceColumns.map((column) => countTextGlyphs(column)),
    ...(preferredColumns ?? []).map((column) => countTextGlyphs(column)),
  );
  if (heightFitLength > 0) {
    const boxPaddingEst = resolveBoxPadding(cloned);
    const availableHeight = Math.max(20, clonedQuadDims.height - boxPaddingEst * 2);
    const maxFontByHeight = Math.round(availableHeight / heightFitLength);
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
  const originalContentWidth = Math.max(20, clonedQuadDims.width - resolveBoxPadding(cloned) * 2);
  const region = expandRegionBeforeRender(cloned, text, measureCtx, ff, noopHLineCount);

  const boxPadding = resolveBoxPadding(region);
  const regionQuadDims = quadDimensions(getRegionQuad(region));
  const contentWidth = Math.max(20, regionQuadDims.width - boxPadding * 2);
  const contentHeight = Math.max(20, regionQuadDims.height - boxPadding * 2);
  let verticalContentHeight = resolveVerticalContentHeight(contentHeight, estimatedInitialFontSize);

  const targetColumnCount = Math.max(
    1,
    sourceColumns.length,
    preferredColumns?.length ?? 0,
    inputRegion.originalLineCount ?? 0,
  );
  const sourceGeometryProfile = resolveVerticalSourceGeometryProfile(region, targetColumnCount);
  const columnAnchor = resolveVerticalSourceColumnAnchor(region, boxPadding, sourceGeometryProfile);

  const preferredProfile = estimateVerticalPreferredProfile(
    measureCtx,
    region,
    text,
    contentWidth,
    verticalContentHeight,
    estimatedInitialFontSize,
    ff,
    region.translatedColumns,
    originalContentWidth,
    sourceGeometryProfile,
  );

  const verticalLayoutOptions: BuildVerticalLayoutOptions = {
    colSpacingScale: preferredProfile.colSpacingScale,
    advanceScale: preferredProfile.advanceScale,
    actualBoxScale: sourceGeometryProfile ? sourceGeometryActualBoxScale : undefined,
    useDefaultAdvanceBase: Boolean(sourceGeometryProfile),
    columnAnchor,
    preferredColumns: region.translatedColumns,
    preferredColumnSources,
  };

  const baseLayout = buildVerticalLayout(measureCtx, text, verticalContentHeight, estimatedInitialFontSize, ff, verticalLayoutOptions);
  let fontSize = estimatedInitialFontSize;
  let layout = baseLayout;
  let layoutContentHeight = verticalContentHeight;
  let renderContentHeight = verticalContentHeight;
  let perColumnMaxHeight: ((columnIndex: number) => number) | undefined;

  if (baseLayout.columns.length > targetColumnCount && inputRegion.bubbleMask) {
    const mask = inputRegion.bubbleMask;
    const boxTop = region.box.y + boxPadding;
    const boxLeft = region.box.x + boxPadding;
    const sw = strokeWidth(estimatedInitialFontSize);
    const safetyMargin = sw + 2;

    const positions = resolveVerticalColumnPositions(
      layout.columns.length,
      contentWidth,
      layout.metrics,
      0,
      verticalLayoutOptions.columnAnchor,
    );

    const perColMaxHeights: number[] = [];
    for (let c = 0; c < layout.columns.length; c++) {
      const localCx = positions.centers[c];
      const colHalfW = layout.metrics.colWidth / 2 + sw;
      const imageXStart = boxLeft + localCx - colHalfW;
      const imageXEnd = boxLeft + localCx + colHalfW;
      const maskMaxY = queryMaskMaxY(mask, imageXStart, imageXEnd, boxTop);
      perColMaxHeights.push(Math.max(verticalContentHeight, maskMaxY - boxTop - safetyMargin));
    }

    layoutContentHeight = Math.max(verticalContentHeight, ...perColMaxHeights);
    if (!sourceGeometryProfile) {
      renderContentHeight = layoutContentHeight;
    }
    perColumnMaxHeight = (ci: number) => perColMaxHeights[ci] ?? verticalContentHeight;

    const extendedProfile = estimateVerticalPreferredProfile(
      measureCtx, region, text, contentWidth, layoutContentHeight,
      estimatedInitialFontSize, ff, region.translatedColumns,
      originalContentWidth,
      sourceGeometryProfile,
    );
    const extendedOptions: BuildVerticalLayoutOptions = {
      ...verticalLayoutOptions,
      colSpacingScale: extendedProfile.colSpacingScale,
      advanceScale: extendedProfile.advanceScale,
      perColumnMaxHeight,
    };
    const extendedLayout = buildVerticalLayout(
      measureCtx, text, layoutContentHeight, estimatedInitialFontSize, ff, extendedOptions,
    );
    layout = extendedLayout;
    verticalLayoutOptions.colSpacingScale = extendedOptions.colSpacingScale;
    verticalLayoutOptions.advanceScale = extendedOptions.advanceScale;
    verticalLayoutOptions.perColumnMaxHeight = perColumnMaxHeight;
  }

  const shrunk = tryShrinkVerticalForMinorOverflow(
    measureCtx,
    text,
    layoutContentHeight,
    estimatedInitialFontSize,
    verticalLayoutOptions,
    layout,
    ff,
  );
  fontSize = shrunk.fontSize;
  layout = shrunk.layout;

  if (layout.columns.length > targetColumnCount && fontSize > minFontSafetySize) {
    const minAllowed = Math.max(minFontSafetySize, Math.ceil(estimatedInitialFontSize * 0.3));
    let lo = minAllowed;
    let hi = fontSize - 1;
    let bestFs = fontSize;
    let bestLayout = layout;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const profile = estimateVerticalPreferredProfile(
        measureCtx, region, text, contentWidth, layoutContentHeight, mid, ff, region.translatedColumns,
        originalContentWidth,
        sourceGeometryProfile,
      );
      const opts: BuildVerticalLayoutOptions = {
        ...verticalLayoutOptions,
        colSpacingScale: profile.colSpacingScale,
        advanceScale: profile.advanceScale,
        perColumnMaxHeight,
      };
      const candidate = buildVerticalLayout(measureCtx, text, layoutContentHeight, mid, ff, opts);
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
    renderContentHeight,
    metrics,
    alignment,
    strokePadding,
    measureCtx,
    fontSize,
    verticalLayoutOptions.columnAnchor,
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
    offscreenHeight: Math.ceil(renderContentHeight + strokePadding * 2),
    boxPadding,
    strokePadding,
    contentWidth,
    verticalContentHeight: renderContentHeight,
    alignment,
    columnAnchor: verticalLayoutOptions.columnAnchor,
    layoutDiagnostics: {
      sourceGeometryProfileUsed: Boolean(sourceGeometryProfile),
      advanceScale: verticalLayoutOptions.advanceScale ?? 1,
      colSpacingScale: verticalLayoutOptions.colSpacingScale ?? 1,
      actualBoxScale: verticalLayoutOptions.actualBoxScale,
      useDefaultAdvanceBase: verticalLayoutOptions.useDefaultAdvanceBase ?? false,
      layoutContentHeight,
      renderContentHeight,
    },
  };
}
