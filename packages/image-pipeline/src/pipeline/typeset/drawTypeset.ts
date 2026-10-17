import type { PipelineTypesetDebugLog, TextDirection, TextRegion, TypesetDebugRegionLog } from "../../types";
import type { PlatformProvider, PipelineCanvas } from "../../runtime/platform";
import { resolveColors } from "./color";
import {
  mapOffscreenPointToCanvas,
  mapOffscreenRectToCanvasQuad,
  cloneQuad,
  cloneRegionForTypeset,
} from "./geometry";
import { segmentVerticalGraphemes } from "./verticalOrientation";
import { computeFullVerticalTypeset } from "./verticalLayout";
import { renderHorizontal } from "./renderHorizontal";
import { buildHorizontalGlyphPlacements } from "./horizontalFit";
import { renderVertical } from "./renderVertical";
import { compositeRegion } from "./composite";
import { drawTypesetDebugOverlay } from "./debug";
import {
  computeFullHorizontalTypeset,
  resolveHorizontalLetterSpacing,
} from "./horizontalLayout";
import type { RegionTypesetDebug } from "./fontMetrics";
import type { CompositeTransform } from "./geometry";
import { formatTypesetFont, resolveTypesetFontFamily } from "./fontRuntime";
import type { EditableTextGlyph, LayerTransform, TypesetLayerCanvas } from '../../editor/types';
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export type DrawTypesetOptions = {
  debugMode?: boolean;
  renderText?: boolean;
  collectDebugLog?: boolean;
  onTextLayer?: (layer: TypesetLayerCanvas) => void;
};

export type DrawTypesetResult = {
  canvas: PipelineCanvas;
  debugLog: PipelineTypesetDebugLog | null;
};

export async function drawTypeset(
  canvas: PipelineCanvas,
  regions: TextRegion[],
  targetLang: string | undefined,
  options: DrawTypesetOptions | undefined,
  platform: PlatformProvider,
): Promise<DrawTypesetResult> {
  const debugMode = options?.debugMode === true;
  const renderText = options?.renderText !== false;
  const collectDebugLog = options?.collectDebugLog === true;
  // Ensure fonts are loaded before measuring/rendering
  await platform.waitForFonts();

  const fontFamily = resolveTypesetFontFamily(targetLang);

  const out = platform.createCanvas(canvas.width, canvas.height);

  const ctx = out.getContext("2d");
  if (!ctx) {
    throw new Error("排版阶段无法获取画布上下文");
  }

  ctx.drawImage(canvas, 0, 0);

  // We need a scratch context for text measurement (shared across regions)
  const measureCanvas = platform.createCanvas(1, 1);
  measureCanvas.height = 1;
  const measureCtx = measureCanvas.getContext("2d")!;

  const renderRegions = regions.map(cloneRegionForTypeset);
  const debugRegions: TypesetDebugRegionLog[] = [];

  for (let regionIndex = 0; regionIndex < renderRegions.length; regionIndex += 1) {
    const inputRegion = renderRegions[regionIndex];
    const translatedRaw = inputRegion.translatedText;
    const isVerticalInput = inputRegion.direction === "v";

    let offCanvas: PipelineCanvas | null = null;
    let debug: RegionTypesetDebug;
    let region: TextRegion;
    let estimatedInitialFontSize: number;
    let text: string;
    let preferredColumns: string[] | undefined;
    let sourceColumns: string[];
    let sourceColumnLengths: number[];
    let singleColumnMaxLength: number | null;
    let editingGlyphs: { ch: string; x: number; y: number; width: number; height: number; baselineY?: number }[] = [];

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
          fontFamily,
          vResult.columnStartOffsets,
          vResult.columnAnchor,
          platform,
        );
      }
      if (options?.onTextLayer) editingGlyphs = vResult.columns.flatMap((column, i) => {
        const box = vResult.debugColumnBoxes[i]; if (!box) return [];
        let y = box.y;
        return column.glyphs.flatMap((glyph) => {
          const characters = segmentVerticalGraphemes(glyph.sourceText), height = glyph.advanceY / Math.max(1, characters.length);
          const placements = characters.map((ch, index) => ({ ch, x: box.x + box.width / 2,
            y: y + height * (index + .5), width: vResult.fittedFontSize, height }));
          y += glyph.advanceY; return placements;
        });
      });
      debug = {
        fittedFontSize: vResult.fittedFontSize,
        columnBoxes: vResult.debugColumnBoxes,
        columnGlyphCenters: vResult.columns.map((col, i) => {
          const box = vResult.debugColumnBoxes[i];
          if (!box) return [];
          let penY = box.y;
          return col.glyphs.flatMap((glyph) => {
            const sourceGraphemes = segmentVerticalGraphemes(glyph.sourceText);
            const centers = sourceGraphemes.map((ch, sourceIndex) => ({
              ch,
              x: box.x + box.width / 2,
              y: penY + glyph.advanceY * (sourceIndex + 0.5) / sourceGraphemes.length,
            }));
            penY += glyph.advanceY;
            return centers;
          });
        }),
        columnVerticalItems: vResult.columns.map((col, i) => {
          const box = vResult.debugColumnBoxes[i];
          if (!box) return [];
          let penY = box.y;
          return col.glyphs.map((glyph) => {
            const item = {
              sourceText: glyph.sourceText,
              displayText: glyph.displayText,
              kind: glyph.kind,
              orientation: glyph.orientation,
              unicodeOrientation: glyph.unicodeOrientation,
              policy: glyph.kind === "tate-chu-yoko" ? glyph.policy : undefined,
              rotationDeg: glyph.kind === "sideways-run" ? glyph.rotationDeg : undefined,
              sourceStart: glyph.sourceStart,
              sourceEnd: glyph.sourceEnd,
              sourceGlyphCount: glyph.sourceGlyphCount,
              x: box.x + box.width / 2,
              y: penY + glyph.advanceY / 2,
              advanceY: glyph.advanceY,
              inkWidth: glyph.inkWidth,
              inkHeight: glyph.inkHeight,
              renderInlineScale: glyph.renderInlineScale,
              renderCrossScale: glyph.renderCrossScale,
              renderOffsetX: glyph.renderOffsetX,
              renderOffsetY: glyph.renderOffsetY,
              boundaryGap: glyph.boundaryGap,
            };
            penY += glyph.advanceY;
            return item;
          });
        }),
        columnBreakReasons: vResult.columnBreakReasons,
        columnSegmentIds: vResult.columnSegmentIds,
        columnSegmentSources: vResult.columnSegmentSources,
        layoutDiagnostics: vResult.layoutDiagnostics,
        offscreenWidth: vResult.offscreenWidth,
        offscreenHeight: vResult.offscreenHeight,
        boxPadding: vResult.boxPadding,
        strokePadding: vResult.strokePadding,
      };
    } else {
      const horizontal = computeFullHorizontalTypeset({
        region: inputRegion,
        fontFamily,
        measureCtx,
      });
      if (!horizontal) continue;

      region = horizontal.expandedRegion;
      estimatedInitialFontSize = horizontal.initialFontSize;
      text = horizontal.text;
      preferredColumns = horizontal.preferredLines;
      sourceColumns = horizontal.sourceLines;
      sourceColumnLengths = horizontal.sourceLineLengths;
      singleColumnMaxLength = horizontal.singleLineMaxLength;

      const colors = resolveColors(region.fgColor, region.bgColor);
      measureCtx.font = formatTypesetFont(horizontal.fittedFontSize, fontFamily);
      const horizontalGlyphPlacements = buildHorizontalGlyphPlacements(
        measureCtx,
        horizontal.lineBoxes,
        resolveHorizontalLetterSpacing(
          horizontal.fittedFontSize,
          horizontal.letterSpacingScale,
        ),
      );
      if (options?.onTextLayer) editingGlyphs = horizontalGlyphPlacements.flatMap((line) => line.map((glyph) => ({
        ch: glyph.ch, x: glyph.centerX, y: glyph.centerY, width: Math.max(.01, glyph.width),
        height: horizontal.fittedFontSize, baselineY: glyph.baselineY,
      })));
      if (renderText) {
        offCanvas = renderHorizontal(
          horizontal.lineBoxes,
          horizontal.fittedFontSize,
          horizontal.contentWidth,
          horizontal.contentHeight,
          colors,
          horizontal.strokePadding,
          fontFamily,
          horizontal.letterSpacingScale,
          platform,
          horizontalGlyphPlacements,
        );
      }
      debug = {
        fittedFontSize: horizontal.fittedFontSize,
        columnBoxes: horizontal.debugColumnBoxes,
        columnGlyphCenters: horizontalGlyphPlacements.map((line) => (
          line
            .filter((glyph) => !/^\s+$/u.test(glyph.ch))
            .map((glyph) => ({
              ch: glyph.ch,
              x: glyph.centerX,
              y: glyph.centerY,
            }))
        )),
        columnBreakReasons: horizontal.lineBreakReasons,
        columnSegmentIds: horizontal.lineSegmentIds,
        columnSegmentSources: horizontal.lineSegmentSources,
        layoutDiagnostics: horizontal.layoutDiagnostics,
        offscreenWidth: horizontal.offscreenWidth,
        offscreenHeight: horizontal.offscreenHeight,
        boxPadding: horizontal.boxPadding,
        strokePadding: horizontal.strokePadding,
      };
    }

    let transform: CompositeTransform | null = null;
    if (offCanvas) {
      transform = compositeRegion(
        ctx,
        offCanvas,
        region,
        debug.boxPadding,
        debug.strokePadding,
      );
      if (options?.onTextLayer) {
        const c = transform ? Math.cos(transform.angle) * transform.s : 1;
        const s = transform ? Math.sin(transform.angle) * transform.s : 0;
        const matrix: LayerTransform = transform
          ? [c, s, -s, c,
              transform.cx - c * offCanvas.width / 2 + s * offCanvas.height / 2,
              transform.cy - s * offCanvas.width / 2 - c * offCanvas.height / 2]
          : [1, 0, 0, 1,
              region.box.x + debug.boxPadding - debug.strokePadding,
              region.box.y + debug.boxPadding - debug.strokePadding];
        const point = (x: number, y: number) => ({
          x: matrix[0] * x + matrix[2] * y + matrix[4],
          y: matrix[1] * x + matrix[3] * y + matrix[5],
        });
        const rawText = translatedRaw.trim() ? translatedRaw : inputRegion.sourceText;
        let sourceIndex = 0;
        const glyphs: EditableTextGlyph[] = editingGlyphs.map(({ ch, ...placement }) => {
          const match = rawText.indexOf(ch, sourceIndex);
          const start = match < 0 ? sourceIndex : match;
          sourceIndex = Math.min(rawText.length, start + ch.length);
          return { start, end: sourceIndex, ...placement };
        });
        options.onTextLayer({
          canvas: offCanvas,
          region: { ...inputRegion, translatedText: translatedRaw.trim() ? translatedRaw : inputRegion.sourceText },
          transform: matrix,
          quad: [point(0, 0), point(offCanvas.width, 0),
            point(offCanvas.width, offCanvas.height), point(0, offCanvas.height)],
          layout: { fontSize: debug.fittedFontSize, fontFamily,
            color: resolveColors(region.fgColor, region.bgColor).fg,
            direction: isVerticalInput ? 'v' : 'h', glyphs },
        });
      }
    }

    if (debugMode) {
      drawTypesetDebugOverlay(ctx, inputRegion, region, regionIndex, estimatedInitialFontSize, debug, transform);
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
          transform,
        )
      );
      const columnGlyphCenters = (debug.columnGlyphCenters ?? []).map((column) =>
        column.map((center) => {
          const mapped = mapOffscreenPointToCanvas(
            region,
            center,
            debug.offscreenWidth,
            debug.offscreenHeight,
            debug.boxPadding,
            debug.strokePadding,
            transform,
          );
          return {
            ch: center.ch,
            x: mapped.x,
            y: mapped.y,
          };
        })
      );
      const columnVerticalItems = (debug.columnVerticalItems ?? []).map((column) =>
        column.map((item) => {
          const mapped = mapOffscreenPointToCanvas(
            region,
            item,
            debug.offscreenWidth,
            debug.offscreenHeight,
            debug.boxPadding,
            debug.strokePadding,
            transform,
          );
          return {
            ...item,
            x: mapped.x,
            y: mapped.y,
          };
        })
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
        layoutDiagnostics: debug.layoutDiagnostics ? { ...debug.layoutDiagnostics } : undefined,
        columnBoxes: debug.columnBoxes.map((box) => ({ ...box })),
        columnCanvasQuads,
        columnGlyphCenters,
        columnVerticalItems,
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
