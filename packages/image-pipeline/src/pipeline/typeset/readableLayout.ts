import type { TextRegion } from '../../types';
import type { PipelineRenderingContext } from '../../runtime/platform';
import { cloneRegionForTypeset } from './geometry';
import { countTextLength, KINSOKU_NEND, KINSOKU_NSTART, resolveSourceColumns } from './columns';
import { buildVerticalLayout, buildVerticalDebugColumnBoxes, computeVerticalTotalWidth, resolveVerticalRenderPadding } from './verticalFit';
import { calcHorizontal, resolveHorizontalRenderPadding } from './horizontalLayout';
import { buildHorizontalLineBoxes, resolveHorizontalLineMetrics } from './horizontalFit';
import type { FullVerticalTypesetResult } from './verticalLayout';
import type { FullHorizontalTypesetResult } from './horizontalLayout';
import { formatTypesetFont } from './fontRuntime';

type ReadableLayoutInput = {
  region: TextRegion;
  fontFamily: string;
  measureCtx: PipelineRenderingContext;
  minimumFontSize: number;
  preferredFontSize?: number;
};

function sourceDetails(region: TextRegion) {
  const columns = resolveSourceColumns(region);
  const lengths = columns.map(countTextLength);
  return { columns, lengths, maxLength: lengths.length ? Math.max(...lengths) : null };
}

const spacingProfiles = [
  { advanceScale: 1, colSpacingScale: 1, letterSpacingScale: 1, lineHeightScale: 1 },
  { advanceScale: 0.94, colSpacingScale: 0.5, letterSpacingScale: 1.15, lineHeightScale: 0.92 },
  { advanceScale: 0.86, colSpacingScale: 0, letterSpacingScale: 1.35, lineHeightScale: 0.84 },
  { advanceScale: 0.75, colSpacingScale: 0, letterSpacingScale: 1.5, lineHeightScale: 0.75 },
] as const;
type SpacingProfile = typeof spacingProfiles[number];

/** Unlike the source-style layout, bounded reflow must not hang punctuation
 * beyond the last row. Move the preceding glyph with it when there is room. */
function wrapBounded<T>(items: readonly T[], limit: number, size: (item: T) => number, source: (item: T) => string): T[][] {
  const lines: T[][] = [];
  let line: T[] = [];
  let used = 0;
  for (const item of items) {
    const advance = size(item);
    if (line.length && used + advance > limit) {
      const last = line[line.length - 1];
      const carry = (KINSOKU_NSTART.has([...source(item)][0])
        || KINSOKU_NEND.has([...source(last)].at(-1)!))
        && line.length > 1 && size(last) + advance <= limit ? line.pop() : undefined;
      lines.push(line);
      line = carry === undefined ? [] : [carry];
      used = carry === undefined ? 0 : size(carry);
    }
    line.push(item);
    used += advance;
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Fixed bounds, full text, spacing first. A readability target cannot justify
 * overlap: only relax the target if even the tightest safe layout cannot fit. */
function fitBounded<T>(target: number, build: (font: number, profile: SpacingProfile) => T, fits: (layout: T) => boolean) {
  for (const profile of spacingProfiles) {
    const layout = build(target, profile);
    if (fits(layout)) return { layout, fontSize: target, profile };
  }
  const profile = spacingProfiles[spacingProfiles.length - 1];
  let low = 1;
  let high = target;
  let best = build(low, profile);
  if (!fits(best)) throw new Error('文字区域过小，无法在边界内完整排版');
  // Bounded search avoids a per-pixel/font-size loop on high-resolution pages.
  for (let attempt = 0; attempt < 12 && high - low > 0.25; attempt += 1) {
    const fontSize = Math.floor((low + high) * 2) / 4;
    const candidate = build(fontSize, profile);
    if (fits(candidate)) { low = fontSize; best = candidate; }
    else high = fontSize;
  }
  return { layout: best, fontSize: low, profile };
}

export function computeReadableVerticalTypeset(input: ReadableLayoutInput): FullVerticalTypesetResult {
  const { measureCtx, fontFamily } = input;
  const region = cloneRegionForTypeset(input.region);
  const targetFontSize = Math.max(input.minimumFontSize, input.preferredFontSize ?? 0);
  const text = region.translatedText || region.sourceText;
  const contentWidth = region.box.width;
  const contentHeight = region.box.height;
  const { layout, fontSize, profile } = fitBounded(targetFontSize, (font, spacing) => {
    const candidate = buildVerticalLayout(measureCtx, text, Number.MAX_SAFE_INTEGER, font, fontFamily, {
      advanceScale: spacing.advanceScale, colSpacingScale: spacing.colSpacingScale,
      // Never obtain tighter spacing by allowing the actual glyph ink to overlap.
      actualBoxScale: 1.08,
    });
    candidate.columns = wrapBounded(candidate.columns.flatMap((column) => column.glyphs), contentHeight,
      (glyph) => glyph.advanceY, (glyph) => glyph.sourceText)
      .map((glyphs) => ({ glyphs, height: glyphs.reduce((sum, glyph) => sum + glyph.advanceY, 0) }));
    candidate.columnBreakReasons = candidate.columns.map((_, index) => index === 0 ? 'start' : 'wrap');
    candidate.columnSegmentIds = candidate.columns.map(() => 1);
    candidate.columnSegmentSources = candidate.columns.map(() => 'model');
    if (spacing.colSpacingScale === 0) {
      const inkWidth = Math.max(0, ...candidate.columns.flatMap((column) => column.glyphs.map((glyph) => (
        glyph.kind === 'sideways-run' ? glyph.inkHeight * glyph.renderCrossScale
          : glyph.kind === 'tate-chu-yoko' ? font : glyph.inkWidth
      ))));
      candidate.metrics.colWidth = Math.ceil(Math.max(font, inkWidth + Math.max(1, font * 0.06)));
    }
    candidate.requiredContentWidth = computeVerticalTotalWidth(candidate.columns.length, candidate.metrics);
    return candidate;
  }, (candidate) => candidate.requiredContentWidth <= contentWidth
    && candidate.columns.every((column) => column.height <= contentHeight));
  // The final area is immutable: fitting may change spacing/font, never bounds.
  region.fontSize = fontSize;
  measureCtx.font = formatTypesetFont(fontSize, fontFamily);
  const strokePadding = resolveVerticalRenderPadding(measureCtx, layout.columns, fontSize, layout.metrics, fontFamily);
  const debugColumnBoxes = buildVerticalDebugColumnBoxes(
    layout.columns, contentWidth, contentHeight, layout.metrics, 'center', strokePadding, measureCtx, fontSize,
  );
  const source = sourceDetails(region);
  return {
    expandedRegion: region,
    text,
    sourceColumns: source.columns,
    sourceColumnLengths: source.lengths,
    singleColumnMaxLength: source.maxLength,
    initialFontSize: targetFontSize,
    fittedFontSize: fontSize,
    columns: layout.columns,
    columnBreakReasons: layout.columnBreakReasons,
    columnSegmentIds: layout.columnSegmentIds,
    columnSegmentSources: layout.columnSegmentSources,
    metrics: layout.metrics,
    debugColumnBoxes,
    offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
    offscreenHeight: Math.ceil(contentHeight + strokePadding * 2),
    boxPadding: 0,
    strokePadding,
    contentWidth,
    verticalContentHeight: contentHeight,
    alignment: 'center',
    layoutDiagnostics: {
      sourceGeometryProfileUsed: false,
      advanceScale: profile.advanceScale,
      colSpacingScale: profile.colSpacingScale,
      actualBoxScale: 1.08,
      useDefaultAdvanceBase: false,
      layoutContentHeight: contentHeight,
      renderContentHeight: contentHeight,
      minimumFontSize: input.minimumFontSize,
      minimumFontSizeRelaxed: fontSize < input.minimumFontSize,
      boundedLayout: true,
      spacingTightened: profile !== spacingProfiles[0],
      readabilityReflowed: true,
    },
  };
}

export function computeReadableHorizontalTypeset(input: ReadableLayoutInput): FullHorizontalTypesetResult {
  const { measureCtx, fontFamily } = input;
  const region = cloneRegionForTypeset(input.region);
  const targetFontSize = Math.max(input.minimumFontSize, input.preferredFontSize ?? 0);
  const text = region.translatedText || region.sourceText;
  const contentWidth = region.box.width;
  const contentHeight = region.box.height;
  const { layout, fontSize, profile } = fitBounded(targetFontSize, (font, spacing) => {
    measureCtx.font = formatTypesetFont(font, fontFamily);
    measureCtx.textAlign = 'left';
    measureCtx.textBaseline = 'alphabetic';
    // Horizontal spacing is negative: a LARGER scale tightens it. Cap it using
    // adjacent ink bounds so condensed Latin/CJK glyphs do not touch each other.
    const chars = [...text];
    let letterSpacingScale: number = spacing.letterSpacingScale;
    for (let i = 1; i < chars.length; i += 1) {
      const a = measureCtx.measureText(chars[i - 1]);
      const b = measureCtx.measureText(chars[i]);
      const gap = a.width - (a.actualBoundingBoxRight ?? a.width) - (b.actualBoundingBoxLeft ?? 0);
      letterSpacingScale = Math.min(letterSpacingScale, Math.max(0, (gap - font * 0.03) / (font * 0.05)));
    }
    let lines = calcHorizontal(measureCtx, text, contentWidth, font, fontFamily, letterSpacingScale);
    if (lines.some((line) => line.width > contentWidth)) {
      // Preserve normal word wrapping unless hanging punctuation overflowed.
      const gap = -font * 0.05 * letterSpacingScale;
      lines = lines.flatMap((line) => wrapBounded([...line.text], contentWidth + gap,
        (ch) => measureCtx.measureText(ch).width + gap, (ch) => ch)
        .map((chars) => ({ text: chars.join(''), width: chars.reduce((sum, ch) => sum + measureCtx.measureText(ch).width + gap, -gap) })));
    }
    const metrics = lines.map((line) => resolveHorizontalLineMetrics(measureCtx, line.text, font));
    const naturalPitch = Math.max(font, ...metrics.map((line) => line.lineHeight));
    const pitch = Math.max(naturalPitch * spacing.lineHeightScale,
      ...metrics.map((line) => line.inkHeight + font * 0.08));
    return { lines, letterSpacingScale, pitch, naturalPitch };
  }, (candidate) => candidate.lines.every((line) => line.width <= contentWidth)
    && candidate.lines.length * candidate.pitch <= contentHeight);
  const { lines, letterSpacingScale, pitch } = layout;
  region.fontSize = fontSize;
  measureCtx.font = formatTypesetFont(fontSize, fontFamily);
  const strokePadding = resolveHorizontalRenderPadding(measureCtx, lines, fontSize, fontFamily);
  const lineBoxes = buildHorizontalLineBoxes({
    ctx: measureCtx, lines, region, contentWidth, contentHeight, fontSize,
    padding: strokePadding, alignment: 'center',
  });
  for (const [index, line] of lineBoxes.entries()) {
    line.topY = strokePadding + (contentHeight - lines.length * pitch) / 2 + index * pitch;
    line.baselineY = line.topY + (pitch + line.inkAscent - line.inkDescent) / 2;
    line.lineHeight = pitch;
    line.visualHeight = pitch;
  }
  const source = sourceDetails(region);
  return {
    expandedRegion: region,
    text,
    sourceLines: source.columns,
    sourceLineLengths: source.lengths,
    singleLineMaxLength: source.maxLength,
    initialFontSize: targetFontSize,
    fittedFontSize: fontSize,
    lines,
    lineBoxes,
    lineBreakReasons: lines.map((_, index) => index === 0 ? 'start' : 'wrap'),
    lineSegmentIds: lines.map(() => 1),
    lineSegmentSources: lines.map(() => 'model'),
    contentWidth,
    contentHeight,
    alignment: 'center',
    strokePadding,
    letterSpacingScale,
    lineHeightScale: pitch / layout.naturalPitch,
    layoutDiagnostics: {
      sourceGeometryProfileUsed: false,
      advanceScale: 1,
      colSpacingScale: 1,
      useDefaultAdvanceBase: false,
      layoutContentHeight: contentHeight,
      renderContentHeight: contentHeight,
      minimumFontSize: input.minimumFontSize,
      minimumFontSizeRelaxed: fontSize < input.minimumFontSize,
      boundedLayout: true,
      spacingTightened: profile !== spacingProfiles[0],
      readabilityReflowed: true,
      horizontalReflowed: true,
    },
    debugColumnBoxes: lineBoxes.map((line) => ({ x: line.x, y: line.topY, width: line.width, height: line.visualHeight })),
    offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
    offscreenHeight: Math.ceil(contentHeight + strokePadding * 2),
    boxPadding: 0,
  };
}
