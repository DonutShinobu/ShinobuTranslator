import type {
  PipelineImageData,
  PipelineRenderingContext,
} from '../../runtime/platform';
import type { TextRegion } from '../../types';
import { getRegionQuad, quadAngle } from './geometry';
import { maxSourceGeometryAnchorAngleRad } from './fontFitCore';
import type { HLine } from './fontFitCore';

export {
  calcHorizontalFromLines,
  countNeededRowsAtFontSize,
  estimateHorizontalPreferredProfile,
  horizontalLetterSpacingRatio,
  horizontalLineHeightRatio,
  maxHorizontalLetterSpacingScale,
  minHorizontalLetterSpacingScale,
  minHorizontalLineHeightScale,
  resolveHorizontalContentHeight,
  resolveHorizontalMaskHeight,
  tryShrinkHorizontalForMinorOverflow,
} from './fontFitCore';

export type { HLine, HorizontalFromLinesResult } from './fontFitCore';

export type HorizontalLineMetrics = {
  ascent: number;
  descent: number;
  inkHeight: number;
  lineHeight: number;
};

export type HorizontalSafeInterval = {
  left: number;
  right: number;
  width: number;
  source: 'mask' | 'content';
};

export type HorizontalLineBox = HLine & HorizontalLineMetrics & {
  x: number;
  topY: number;
  baselineY: number;
  maxWidth: number;
  safeInterval: HorizontalSafeInterval;
};

export type HorizontalGlyphPlacement = {
  ch: string;
  x: number;
  baselineY: number;
  centerX: number;
  centerY: number;
  width: number;
};

export type BuildHorizontalLineBoxesInput = {
  ctx: PipelineRenderingContext;
  lines: HLine[];
  region: TextRegion;
  contentWidth: number;
  contentHeight: number;
  fontSize: number;
  padding: number;
  alignment: 'left' | 'center' | 'right';
  anchorContentCenterY?: number;
  sourcePitch?: number;
  bubbleMask?: PipelineImageData;
  boxPadding?: number;
};

export type ResolveHorizontalSafeIntervalInput = {
  mask?: PipelineImageData;
  region: TextRegion;
  contentWidth: number;
  localTopY: number;
  localBottomY: number;
  preferredContentX: number;
  safetyMargin: number;
  boxPadding?: number;
};

function finiteMetric(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.abs(value) : 0;
}

export function resolveHorizontalLineMetrics(
  ctx: PipelineRenderingContext,
  text: string,
  fontSize: number,
  sourcePitch?: number,
): HorizontalLineMetrics {
  const measured = ctx.measureText(text || '国');
  const actualAscent = finiteMetric(measured.actualBoundingBoxAscent);
  const actualDescent = finiteMetric(measured.actualBoundingBoxDescent);
  const fontAscent = finiteMetric(measured.fontBoundingBoxAscent);
  const fontDescent = finiteMetric(measured.fontBoundingBoxDescent);
  const ascent = fontAscent > 0 ? fontAscent : actualAscent > 0 ? actualAscent : fontSize * 0.8;
  const descent = fontDescent > 0 ? fontDescent : actualDescent > 0 ? actualDescent : fontSize * 0.2;
  const actualInkHeight = actualAscent + actualDescent;
  const inkHeight = actualInkHeight > 0 ? actualInkHeight : fontSize;
  const naturalLineHeight = Math.max(fontSize, ascent + descent);
  const lineHeight = Math.max(1, naturalLineHeight, sourcePitch ?? 0);
  return { ascent, descent, inkHeight, lineHeight };
}

function contentInterval(contentWidth: number): HorizontalSafeInterval {
  return {
    left: 0,
    right: contentWidth,
    width: contentWidth,
    source: 'content',
  };
}

export function resolveHorizontalSafeInterval(
  input: ResolveHorizontalSafeIntervalInput,
): HorizontalSafeInterval {
  const {
    mask,
    region,
    contentWidth,
    localTopY,
    localBottomY,
    preferredContentX,
    safetyMargin,
    boxPadding = 0,
  } = input;
  const fallback = contentInterval(contentWidth);
  if (!mask || Math.abs(quadAngle(getRegionQuad(region))) > maxSourceGeometryAnchorAngleRad) {
    return fallback;
  }

  const imageXStart = Math.max(0, Math.round(region.box.x + boxPadding));
  const imageXEnd = Math.min(mask.width - 1, Math.round(imageXStart + contentWidth));
  const imageYStart = Math.max(0, Math.floor(region.box.y + boxPadding + localTopY));
  const imageYEnd = Math.min(mask.height - 1, Math.ceil(region.box.y + boxPadding + localBottomY) - 1);
  if (imageXStart > imageXEnd || imageYStart > imageYEnd) return fallback;

  const runs: Array<{ left: number; right: number }> = [];
  let runStart: number | undefined;
  for (let x = imageXStart; x <= imageXEnd; x += 1) {
    let safe = true;
    for (let y = imageYStart; y <= imageYEnd; y += 1) {
      if (mask.data[(y * mask.width + x) * 4 + 3] === 0) {
        safe = false;
        break;
      }
    }
    if (safe && runStart === undefined) runStart = x;
    if (!safe && runStart !== undefined) {
      runs.push({ left: runStart, right: x - 1 });
      runStart = undefined;
    }
  }
  if (runStart !== undefined) runs.push({ left: runStart, right: imageXEnd });
  if (runs.length === 0) return fallback;

  const preferredImageX = imageXStart + preferredContentX;
  const selected = runs.find((run) => preferredImageX >= run.left && preferredImageX <= run.right)
    ?? [...runs].sort((a, b) => (b.right - b.left) - (a.right - a.left))[0];
  if (!selected) return fallback;

  const left = selected.left - imageXStart + safetyMargin;
  const right = selected.right - imageXStart - safetyMargin;
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return fallback;
  return { left, right, width: right - left, source: 'mask' };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function alignedLineX(
  lineWidth: number,
  interval: HorizontalSafeInterval,
  padding: number,
  alignment: 'left' | 'center' | 'right',
): number {
  if (alignment === 'left') return padding + interval.left;
  if (alignment === 'right') return padding + interval.right - lineWidth;
  return padding + interval.left + (interval.width - lineWidth) / 2;
}

export function buildHorizontalLineBoxes(
  input: BuildHorizontalLineBoxesInput,
): HorizontalLineBox[] {
  const {
    ctx,
    lines,
    region,
    contentWidth,
    contentHeight,
    fontSize,
    padding,
    alignment,
    anchorContentCenterY,
    sourcePitch,
    bubbleMask,
    boxPadding = 0,
  } = input;
  if (lines.length === 0) return [];

  const metricsByLine = lines.map((line) => (
    resolveHorizontalLineMetrics(ctx, line.text, fontSize, sourcePitch)
  ));
  const lineHeight = Math.max(...metricsByLine.map((metrics) => metrics.lineHeight));
  const totalHeight = lineHeight * lines.length;
  const minCenterY = totalHeight / 2;
  const maxCenterY = Math.max(minCenterY, contentHeight - totalHeight / 2);
  const contentCenterY = clampNumber(
    anchorContentCenterY ?? contentHeight / 2,
    minCenterY,
    maxCenterY,
  );
  const contentTopY = contentCenterY - totalHeight / 2;
  const safetyMargin = Math.max(0, Math.ceil(fontSize * 0.08));

  return lines.map((line, index) => {
    const metrics = metricsByLine[index];
    const localTopY = contentTopY + index * lineHeight;
    const safeInterval = resolveHorizontalSafeInterval({
      mask: bubbleMask,
      region,
      contentWidth,
      localTopY,
      localBottomY: localTopY + lineHeight,
      preferredContentX: contentWidth / 2,
      safetyMargin,
      boxPadding,
    });
    const leadingTop = Math.max(0, (lineHeight - metrics.ascent - metrics.descent) / 2);
    return {
      ...line,
      ...metrics,
      lineHeight,
      x: alignedLineX(line.width, safeInterval, padding, alignment),
      topY: padding + localTopY,
      baselineY: padding + localTopY + leadingTop + metrics.ascent,
      maxWidth: safeInterval.width,
      safeInterval,
    };
  });
}

export function buildHorizontalGlyphPlacements(
  ctx: PipelineRenderingContext,
  lines: readonly HorizontalLineBox[],
  letterSpacing: number,
): HorizontalGlyphPlacement[][] {
  return lines.map((line) => {
    const centerY = line.baselineY + (line.descent - line.ascent) / 2;
    let penX = line.x;
    const chars = [...line.text];
    return chars.map((ch, index) => {
      const width = ctx.measureText(ch).width;
      const placement: HorizontalGlyphPlacement = {
        ch,
        x: penX,
        baselineY: line.baselineY,
        centerX: penX + width / 2,
        centerY,
        width,
      };
      if (index < chars.length - 1) {
        penX += width + letterSpacing;
      }
      return placement;
    });
  });
}

function measureSpacedTextWidth(
  ctx: PipelineRenderingContext,
  text: string,
  letterSpacing: number,
): number {
  const chars = [...text];
  return chars.reduce((width, char, index) => (
    width + ctx.measureText(char).width + (index < chars.length - 1 ? letterSpacing : 0)
  ), 0);
}

export function rebalanceHorizontalShortTailLines(
  ctx: PipelineRenderingContext,
  inputLines: HLine[],
  maxWidths: readonly number[],
  letterSpacing: number,
  minTailGlyphCount = 3,
): HLine[] {
  if (inputLines.length < 2) return inputLines;
  const lines = inputLines.map((line) => ({ ...line }));

  for (let lineIndex = lines.length - 1; lineIndex > 0; lineIndex -= 1) {
    const previous = lines[lineIndex - 1];
    const tail = lines[lineIndex];
    if ([...tail.text.trim()].length >= minTailGlyphCount) continue;
    const previousMaxWidth = maxWidths[lineIndex - 1] ?? Number.POSITIVE_INFINITY;
    const tailMaxWidth = maxWidths[lineIndex] ?? Number.POSITIVE_INFINITY;

    const previousWords = previous.text.trim().split(/\s+/).filter(Boolean);
    if (previousWords.length > 1) {
      const moved = previousWords.pop();
      if (moved) {
        const candidatePrevious = previousWords.join(' ');
        const candidateTail = `${moved} ${tail.text.trim()}`.trim();
        const previousWidth = measureSpacedTextWidth(ctx, candidatePrevious, letterSpacing);
        const tailWidth = measureSpacedTextWidth(ctx, candidateTail, letterSpacing);
        if (candidatePrevious && previousWidth <= previousMaxWidth && tailWidth <= tailMaxWidth) {
          previous.text = candidatePrevious;
          previous.width = previousWidth;
          tail.text = candidateTail;
          tail.width = tailWidth;
          continue;
        }
      }
    }

    if (/\s/.test(previous.text) || /\s/.test(tail.text)) continue;
    const previousGlyphs = [...previous.text];
    const tailGlyphs = [...tail.text];
    while (tailGlyphs.length < minTailGlyphCount && previousGlyphs.length > minTailGlyphCount) {
      const moved = previousGlyphs.pop();
      if (!moved) break;
      const candidatePrevious = previousGlyphs.join('');
      const candidateTail = `${moved}${tailGlyphs.join('')}`;
      const previousWidth = measureSpacedTextWidth(ctx, candidatePrevious, letterSpacing);
      const tailWidth = measureSpacedTextWidth(ctx, candidateTail, letterSpacing);
      if (!candidatePrevious || previousWidth > previousMaxWidth || tailWidth > tailMaxWidth) {
        previousGlyphs.push(moved);
        break;
      }
      tailGlyphs.unshift(moved);
      previous.text = candidatePrevious;
      previous.width = previousWidth;
      tail.text = candidateTail;
      tail.width = tailWidth;
    }
  }
  return lines;
}
