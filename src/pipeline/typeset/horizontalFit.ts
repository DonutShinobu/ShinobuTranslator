import type { PipelineRenderingContext } from '../../runtime/platform';
import type { BubbleMask, TextRegion } from '../../types';
import { hasBubbleMaskPixel } from '../bubbleMask';
import { getRegionQuad, quadAngle } from './geometry';
import { maxSourceGeometryAnchorAngleRad } from './fontFitCore';
import type { HLine, HorizontalSourceLineLayout } from './fontFitCore';

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
  inkAscent: number;
  inkDescent: number;
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
  naturalWidth: number;
  visualHeight: number;
  sourceAdvanceScale?: number;
  sourceAnchored: boolean;
  sourceClamped: boolean;
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
  sourceLineLayouts?: readonly HorizontalSourceLineLayout[];
  bubbleMask?: BubbleMask;
  boxPadding?: number;
};

export type ResolveHorizontalSafeIntervalInput = {
  mask?: BubbleMask;
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
  ctx.textBaseline = 'alphabetic';
  const measured = ctx.measureText(text || '国');
  const actualAscent = finiteMetric(measured.actualBoundingBoxAscent);
  const actualDescent = finiteMetric(measured.actualBoundingBoxDescent);
  const fontAscent = finiteMetric(measured.fontBoundingBoxAscent);
  const fontDescent = finiteMetric(measured.fontBoundingBoxDescent);
  const ascent = fontAscent > 0 ? fontAscent : actualAscent > 0 ? actualAscent : fontSize * 0.8;
  const descent = fontDescent > 0 ? fontDescent : actualDescent > 0 ? actualDescent : fontSize * 0.2;
  const inkAscent = actualAscent > 0 ? actualAscent : ascent;
  const inkDescent = actualDescent > 0 ? actualDescent : descent;
  const inkHeight = inkAscent + inkDescent;
  const naturalLineHeight = Math.max(fontSize, ascent + descent);
  const lineHeight = Math.max(1, naturalLineHeight, sourcePitch ?? 0);
  return { ascent, descent, inkAscent, inkDescent, inkHeight, lineHeight };
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

  const contentImageX = Math.round(region.box.x + boxPadding);
  const imageXStart = Math.max(mask.x, contentImageX);
  const imageXEnd = Math.min(
    mask.x + mask.width - 1,
    Math.round(contentImageX + contentWidth),
  );
  const imageYStart = Math.floor(region.box.y + boxPadding + localTopY);
  const imageYEnd = Math.ceil(region.box.y + boxPadding + localBottomY) - 1;
  const maskYEnd = mask.y + mask.height - 1;
  if (imageYStart < mask.y || imageYEnd > maskYEnd) return fallback;
  if (imageXStart > imageXEnd || imageYStart > imageYEnd) return fallback;

  const runs: Array<{ left: number; right: number }> = [];
  let runStart: number | undefined;
  for (let x = imageXStart; x <= imageXEnd; x += 1) {
    let safe = true;
    for (let y = imageYStart; y <= imageYEnd; y += 1) {
      if (!hasBubbleMaskPixel(mask, x, y)) {
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

  const preferredImageX = contentImageX + preferredContentX;
  const selected = runs.find((run) => preferredImageX >= run.left && preferredImageX <= run.right)
    ?? [...runs].sort((a, b) => (b.right - b.left) - (a.right - a.left))[0];
  if (!selected) return fallback;

  const left = selected.left - contentImageX + safetyMargin;
  const right = selected.right - contentImageX - safetyMargin;
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
    sourceLineLayouts,
    bubbleMask,
    boxPadding = 0,
  } = input;
  if (lines.length === 0) return [];

  const resolvedSourceLayouts = sourceLineLayouts?.length === lines.length
    ? sourceLineLayouts
    : undefined;

  const metricsByLine = lines.map((line) => (
    resolveHorizontalLineMetrics(ctx, line.text, fontSize, sourcePitch)
  ));
  const lineHeight = resolvedSourceLayouts
    ? Math.max(1, sourcePitch ?? fontSize)
    : Math.max(...metricsByLine.map((metrics) => metrics.lineHeight));
  const centerOffsets = lines.map((_, index) => (
    (index - (lines.length - 1) / 2) * lineHeight
  ));
  const visualHeights = lines.map((_, index) => (
    resolvedSourceLayouts?.[index]?.targetHeight ?? lineHeight
  ));
  const topOffset = Math.min(...centerOffsets.map((offset, index) => (
    offset - visualHeights[index] / 2
  )));
  const bottomOffset = Math.max(...centerOffsets.map((offset, index) => (
    offset + visualHeights[index] / 2
  )));
  const minCenterY = -topOffset;
  const maxCenterY = Math.max(minCenterY, contentHeight - bottomOffset);
  const contentCenterY = clampNumber(
    anchorContentCenterY ?? contentHeight / 2,
    minCenterY,
    maxCenterY,
  );
  const safetyMargin = Math.max(0, Math.ceil(fontSize * 0.08));

  return lines.map((line, index) => {
    const metrics = metricsByLine[index];
    const sourceLayout = resolvedSourceLayouts?.[index];
    const visualHeight = visualHeights[index];
    const lineCenterY = contentCenterY + centerOffsets[index];
    const localTopY = lineCenterY - visualHeight / 2;
    const measuredSafeInterval = resolveHorizontalSafeInterval({
      mask: bubbleMask,
      region,
      contentWidth,
      localTopY,
      localBottomY: localTopY + visualHeight,
      preferredContentX: sourceLayout
        ? sourceLayout.contentLeftX + sourceLayout.targetWidth / 2
        : contentWidth / 2,
      safetyMargin,
      boxPadding,
    });
    const safeInterval = sourceLayout
      ? (() => {
          const left = Math.max(
            -boxPadding,
            measuredSafeInterval.left - safetyMargin - boxPadding,
          );
          const right = Math.min(
            contentWidth + boxPadding,
            measuredSafeInterval.right + safetyMargin + boxPadding,
          );
          return {
            left,
            right,
            width: Math.max(0, right - left),
            source: measuredSafeInterval.source,
          };
        })()
      : measuredSafeInterval;
    const targetWidth = sourceLayout?.targetWidth ?? line.width;
    const sourceFits = sourceLayout !== undefined && targetWidth <= safeInterval.width + 0.5;
    const desiredLeft = sourceLayout?.contentLeftX ?? 0;
    const clampedLeft = sourceFits
      ? clampNumber(desiredLeft, safeInterval.left, safeInterval.right - targetWidth)
      : desiredLeft;
    const sourceClamped = sourceFits && Math.abs(clampedLeft - desiredLeft) > 0.5;
    const leadingTop = Math.max(0, (lineHeight - metrics.ascent - metrics.descent) / 2);
    const baselineY = sourceLayout
      ? padding + lineCenterY + (metrics.inkAscent - metrics.inkDescent) / 2
      : padding + localTopY + leadingTop + metrics.ascent;
    return {
      ...line,
      ...metrics,
      width: targetWidth,
      lineHeight,
      x: sourceLayout
        ? padding + clampedLeft
        : alignedLineX(line.width, safeInterval, padding, alignment),
      topY: padding + localTopY,
      baselineY,
      maxWidth: safeInterval.width,
      safeInterval,
      naturalWidth: line.width,
      visualHeight,
      sourceAdvanceScale: sourceFits ? sourceLayout.advanceScale : undefined,
      sourceAnchored: sourceFits,
      sourceClamped,
    };
  });
}

export function buildHorizontalGlyphPlacements(
  ctx: PipelineRenderingContext,
  lines: readonly HorizontalLineBox[],
  letterSpacing: number,
): HorizontalGlyphPlacement[][] {
  ctx.textBaseline = 'alphabetic';
  return lines.map((line) => {
    if (line.sourceAnchored) {
      const chars = [...line.text];
      const measurements = chars.map((ch) => ctx.measureText(ch));
      const widths = measurements.map((measurement) => measurement.width);
      const naturalAdvances = widths.map((width, index) => (
        width + (index < chars.length - 1 ? letterSpacing : 0)
      ));
      const naturalTotal = naturalAdvances.reduce((sum, advance) => sum + advance, 0);
      const advanceScale = naturalTotal > 0 ? line.width / naturalTotal : 1;
      let penX = line.x;
      return chars.map((ch, index) => {
        const width = widths[index];
        const measurement = measurements[index];
        const glyphAscent = finiteMetric(measurement.actualBoundingBoxAscent) || line.inkAscent;
        const glyphDescent = finiteMetric(measurement.actualBoundingBoxDescent) || line.inkDescent;
        const allocatedAdvance = naturalAdvances[index] * advanceScale;
        const centerX = penX + allocatedAdvance / 2;
        const placement: HorizontalGlyphPlacement = {
          ch,
          x: centerX - width / 2,
          baselineY: line.baselineY,
          centerX,
          centerY: line.baselineY + (glyphDescent - glyphAscent) / 2,
          width,
        };
        penX += allocatedAdvance;
        return placement;
      });
    }

    let penX = line.x;
    const chars = [...line.text];
    return chars.map((ch, index) => {
      const measurement = ctx.measureText(ch);
      const width = measurement.width;
      const glyphAscent = finiteMetric(measurement.actualBoundingBoxAscent) || line.inkAscent;
      const glyphDescent = finiteMetric(measurement.actualBoundingBoxDescent) || line.inkDescent;
      const placement: HorizontalGlyphPlacement = {
        ch,
        x: penX,
        baselineY: line.baselineY,
        centerX: penX + width / 2,
        centerY: line.baselineY + (glyphDescent - glyphAscent) / 2,
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
