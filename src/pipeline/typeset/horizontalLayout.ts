import type { PipelineRenderingContext } from "../../runtime/platform";
import type { TextRegion } from "../../types";
import {
  KINSOKU_NEND,
  KINSOKU_NSTART,
  resolveHorizontalPreferredLines,
} from "./columns";
import type { ColumnSegmentSource } from "./columns";
import { getRegionQuad, quadDimensions } from "./geometry";
import {
  expandRegionBeforeRender,
  metricAbs,
  minFontSafetySize,
  resolveAlignment,
  resolveBoxPadding,
  resolveInitialFontSize,
  resolveOffscreenGuardPadding,
  strokeWidth,
} from "./fontMetrics";
import {
  calcHorizontalFromLines,
  estimateHorizontalPreferredProfile,
  resolveHorizontalContentHeight,
  resolveHorizontalMaskHeight,
  tryShrinkHorizontalForMinorOverflow,
} from "./horizontalFit";
import type { ColumnBreakReason, DebugColumnBox } from "./fontMetrics";
import type { HLine } from "./horizontalFit";

export const horizontalLetterSpacingRatio = -0.05;
export const horizontalLineHeightRatio = 0.93;

// ---------------------------------------------------------------------------
// Horizontal layout
// ---------------------------------------------------------------------------

/**
 * Detect whether a string contains Latin word characters (needs word-level wrapping).
 */
function hasLatinWords(text: string): boolean {
  return /[a-zA-Z]{2,}/.test(text);
}

export function resolveHorizontalLetterSpacing(fontSize: number, scale: number = 1): number {
  return fontSize * horizontalLetterSpacingRatio * scale;
}

export function resolveHorizontalLineHeight(fontSize: number, scale: number = 1): number {
  return Math.max(1, Math.round(fontSize * horizontalLineHeightRatio * scale));
}

function measureHorizontalTextWidth(
  ctx: PipelineRenderingContext,
  text: string,
  fontSize: number,
  letterSpacingScale: number = 1,
): number {
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }

  if (chars.length === 1) {
    return ctx.measureText(chars[0]).width;
  }

  const letterSpacing = resolveHorizontalLetterSpacing(fontSize, letterSpacingScale);
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
 * Split text into wrapped lines for horizontal rendering.
 * - For CJK: character-level wrapping with kinsoku shori punctuation rules.
 * - For Latin: word-level wrapping with character fallback for long words.
 */
export function calcHorizontal(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string,
  letterSpacingScale: number = 1,
): HLine[] {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const cleaned = text.replace(/\n+/g, " ").trim();
  if (!cleaned) return [];

  if (hasLatinWords(cleaned)) {
    return calcHorizontalLatin(ctx, cleaned, maxWidth, fontSize, letterSpacingScale);
  }
  return calcHorizontalCjk(ctx, cleaned, maxWidth, fontSize, letterSpacingScale);
}

/**
 * CJK character-level line breaking with kinsoku shori.
 */
function calcHorizontalCjk(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacingScale: number = 1,
): HLine[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: HLine[] = [];
  let line = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const trial = line + ch;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize, letterSpacingScale);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // Line is full — push current line, but apply kinsoku rules
    if (line.length > 0) {
      const lastChar = line[line.length - 1];
      const nextChar = ch;

      // If next char can't start a line, keep it on current line
      if (KINSOKU_NSTART.has(nextChar) && line.length > 0) {
        line += ch;
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
        line = "";
        continue;
      }

      // If current line's last char can't end a line, move it to next line
      if (KINSOKU_NEND.has(lastChar) && line.length > 1) {
        const carry = line[line.length - 1];
        line = line.slice(0, -1);
        lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
        line = carry + ch;
        continue;
      }

      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
    }
    line = ch;
  }

  if (line) {
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
  }
  return lines;
}

/**
 * Latin word-level line breaking. Falls back to character-level for long words.
 */
function calcHorizontalLatin(
  ctx: PipelineRenderingContext,
  text: string,
  maxWidth: number,
  fontSize: number,
  letterSpacingScale: number = 1,
): HLine[] {
  const words = text.split(/\s+/);
  const lines: HLine[] = [];
  let line = "";

  for (const word of words) {
    const trial = line ? line + " " + word : word;
    const trialWidth = measureHorizontalTextWidth(ctx, trial, fontSize, letterSpacingScale);

    if (trialWidth <= maxWidth) {
      line = trial;
      continue;
    }

    // If current line is non-empty, push it
    if (line) {
      lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
      line = "";
    }

    // Check if the word itself exceeds maxWidth — character-break it
    if (measureHorizontalTextWidth(ctx, word, fontSize, letterSpacingScale) > maxWidth) {
      const chars = [...word];
      let frag = "";
      for (const ch of chars) {
        const fragTrial = frag + ch;
        if (measureHorizontalTextWidth(ctx, fragTrial, fontSize, letterSpacingScale) > maxWidth && frag) {
          lines.push({ text: frag, width: measureHorizontalTextWidth(ctx, frag, fontSize, letterSpacingScale) });
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
    lines.push({ text: line, width: measureHorizontalTextWidth(ctx, line, fontSize, letterSpacingScale) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------


export function resolveHorizontalRenderPadding(
  ctx: PipelineRenderingContext,
  lines: HLine[],
  fontSize: number,
  fontFamily: string,
  letterSpacingScale: number = 1,
): number {
  if (lines.length === 0) {
    return strokeWidth(fontSize) + 2;
  }

  ctx.font = `${fontSize}px ${fontFamily}`;
  const letterSpacing = resolveHorizontalLetterSpacing(fontSize, letterSpacingScale);
  let maxOverflow = 0;

  for (const line of lines) {
    const chars = [...line.text];
    if (chars.length === 0) {
      continue;
    }

    let penX = 0;
    let minX = 0;
    let maxX = line.width;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const metrics = ctx.measureText(ch);
      const left = metricAbs(metrics.actualBoundingBoxLeft ?? 0);
      const right = metricAbs(metrics.actualBoundingBoxRight ?? 0);

      minX = Math.min(minX, penX - left);
      maxX = Math.max(maxX, penX + right);

      if (i < chars.length - 1) {
        penX += metrics.width + letterSpacing;
      }
    }

    const leftOverflow = Math.max(0, -minX);
    const rightOverflow = Math.max(0, maxX - line.width);
    maxOverflow = Math.max(maxOverflow, leftOverflow, rightOverflow);
  }

  const sw = strokeWidth(fontSize);
  const basePadding = sw + 2;
  const fallbackPadding = Math.ceil(fontSize * 0.12);
  const overflowPadding = Math.max(Math.ceil(maxOverflow), fallbackPadding);
  return basePadding + overflowPadding + resolveOffscreenGuardPadding(fontSize);
}

export function computeAlignX(
  lineWidth: number,
  contentWidth: number,
  padding: number,
  alignment: "left" | "center" | "right",
): number {
  switch (alignment) {
    case "left":
      return padding;
    case "right":
      return padding + contentWidth - lineWidth;
    case "center":
    default:
      return padding + (contentWidth - lineWidth) / 2;
  }
}

export function buildHorizontalDebugColumnBoxes(
  lines: HLine[],
  contentWidth: number,
  contentHeight: number,
  fontSize: number,
  alignment: "left" | "center" | "right",
  padding: number,
  lineHeightScale: number = 1,
): DebugColumnBox[] {
  if (lines.length === 0) {
    return [];
  }
  const lineHeight = resolveHorizontalLineHeight(fontSize, lineHeightScale);
  const totalTextH = lines.length * lineHeight;
  const offsetY = padding + Math.max(0, (contentHeight - totalTextH) / 2);
  return lines.map((line, index) => ({
    x: computeAlignX(line.width, contentWidth, padding, alignment),
    y: offsetY + index * lineHeight,
    width: line.width,
    height: lineHeight,
  }));
}

export type FullHorizontalTypesetInput = {
  region: TextRegion;
  fontFamily: string;
  measureCtx: PipelineRenderingContext;
};

export type FullHorizontalTypesetResult = {
  expandedRegion: TextRegion;
  text: string;
  preferredLines?: string[];
  sourceLines: string[];
  sourceLineLengths: number[];
  singleLineMaxLength: number | null;
  initialFontSize: number;
  fittedFontSize: number;
  lines: HLine[];
  lineBreakReasons: ColumnBreakReason[];
  lineSegmentIds: number[];
  lineSegmentSources: ColumnSegmentSource[];
  contentWidth: number;
  contentHeight: number;
  alignment: "left" | "center" | "right";
  strokePadding: number;
  letterSpacingScale: number;
  lineHeightScale: number;
  debugColumnBoxes: DebugColumnBox[];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
};

export function computeFullHorizontalTypeset(
  input: FullHorizontalTypesetInput,
): FullHorizontalTypesetResult | null {
  const { region: inputRegion, fontFamily, measureCtx } = input;
  const translated = inputRegion.translatedText || inputRegion.sourceText;
  if (!translated.trim()) return null;

  const horizontalPreferred = resolveHorizontalPreferredLines(inputRegion, translated);
  const preferredLineSegments = horizontalPreferred.lines;
  const preferredLines = preferredLineSegments.length > 0
    ? preferredLineSegments.map((segment) => segment.text)
    : undefined;
  const sourceLines = horizontalPreferred.sourceLines;
  const sourceLineLengths = horizontalPreferred.sourceLineLengths;
  const singleLineMaxLength = horizontalPreferred.singleLineMaxLength;
  const text = translated;

  let estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(inputRegion)));
  const inputQuadDims = quadDimensions(getRegionQuad(inputRegion));
  if (singleLineMaxLength && singleLineMaxLength > 0) {
    const boxPaddingEst = resolveBoxPadding(inputRegion);
    const availableWidth = Math.max(20, inputQuadDims.width - boxPaddingEst * 2);
    const maxFontByWidth = Math.floor(availableWidth / (singleLineMaxLength * 1.1));
    if (maxFontByWidth > 0 && maxFontByWidth < estimatedInitialFontSize) {
      estimatedInitialFontSize = Math.max(8, maxFontByWidth);
    }
  }

  const calcHorizontalLineCount = (
    context: PipelineRenderingContext,
    candidateText: string,
    maxWidth: number,
    fontSize: number,
  ): number => {
    if (preferredLineSegments.length > 0) {
      context.font = `${fontSize}px ${fontFamily}`;
      return calcHorizontalFromLines(
        context,
        preferredLineSegments,
        maxWidth,
        fontSize,
      ).lines.length;
    }
    return calcHorizontal(
      context,
      candidateText,
      maxWidth,
      fontSize,
      fontFamily,
    ).length;
  };
  const expandedRegion = expandRegionBeforeRender(
    inputRegion,
    text,
    measureCtx,
    fontFamily,
    calcHorizontalLineCount,
  );
  const boxPadding = resolveBoxPadding(expandedRegion);
  const regionQuadDims = quadDimensions(getRegionQuad(expandedRegion));
  const contentWidth = Math.max(20, regionQuadDims.width - boxPadding * 2);
  const contentHeight = Math.max(20, regionQuadDims.height - boxPadding * 2);
  const originalContentHeight = Math.max(
    20,
    inputQuadDims.height - resolveBoxPadding(inputRegion) * 2,
  );
  const preferredProfile = estimateHorizontalPreferredProfile(
    measureCtx,
    expandedRegion,
    text,
    contentWidth,
    contentHeight,
    estimatedInitialFontSize,
    fontFamily,
    preferredLines,
    originalContentHeight,
  );
  let letterSpacingScale = preferredProfile.letterSpacingScale;
  let lineHeightScale = preferredProfile.lineHeightScale;
  let fontSize = estimatedInitialFontSize;
  let lines: HLine[];
  let lineBreakReasons: ColumnBreakReason[];
  let lineSegmentIds: number[];
  let lineSegmentSources: ColumnSegmentSource[];

  if (preferredLineSegments.length > 0) {
    measureCtx.font = `${fontSize}px ${fontFamily}`;
    const horizontalResult = calcHorizontalFromLines(
      measureCtx,
      preferredLineSegments,
      contentWidth,
      fontSize,
      letterSpacingScale,
    );
    lines = horizontalResult.lines;
    lineBreakReasons = horizontalResult.lineBreakReasons;
    lineSegmentIds = horizontalResult.lineSegmentIds;
    lineSegmentSources = horizontalResult.lineSegmentSources;
  } else {
    measureCtx.font = `${fontSize}px ${fontFamily}`;
    lines = calcHorizontal(
      measureCtx,
      text,
      contentWidth,
      fontSize,
      fontFamily,
      letterSpacingScale,
    );
    lineBreakReasons = lines.map((_, index) => (index === 0 ? 'start' : 'wrap'));
    lineSegmentIds = lines.map(() => 1);
    lineSegmentSources = lines.map(() => 'model');
  }

  const calculateLines = (
    context: PipelineRenderingContext,
    candidateText: string,
    maxWidth: number,
    candidateFontSize: number,
  ): HLine[] => {
    if (preferredLineSegments.length > 0) {
      context.font = `${candidateFontSize}px ${fontFamily}`;
      return calcHorizontalFromLines(
        context,
        preferredLineSegments,
        maxWidth,
        candidateFontSize,
        letterSpacingScale,
      ).lines;
    }
    return calcHorizontal(
      context,
      candidateText,
      maxWidth,
      candidateFontSize,
      fontFamily,
      letterSpacingScale,
    );
  };
  const shrinkResult = tryShrinkHorizontalForMinorOverflow(
    measureCtx,
    text,
    contentWidth,
    estimatedInitialFontSize,
    fontFamily,
    lines,
    calculateLines,
  );
  fontSize = shrinkResult.fontSize;
  lines = shrinkResult.lines;

  if (fontSize !== estimatedInitialFontSize && preferredLineSegments.length > 0) {
    measureCtx.font = `${fontSize}px ${fontFamily}`;
    const horizontalResult = calcHorizontalFromLines(
      measureCtx,
      preferredLineSegments,
      contentWidth,
      fontSize,
      letterSpacingScale,
    );
    lineBreakReasons = horizontalResult.lineBreakReasons;
    lineSegmentIds = horizontalResult.lineSegmentIds;
    lineSegmentSources = horizontalResult.lineSegmentSources;
  } else if (fontSize !== estimatedInitialFontSize) {
    lineBreakReasons = lines.map((_, index) => (index === 0 ? 'start' : 'wrap'));
    lineSegmentIds = lines.map(() => 1);
    lineSegmentSources = lines.map(() => 'model');
  }

  let horizontalContentHeight = resolveHorizontalContentHeight(contentHeight, fontSize);
  horizontalContentHeight = resolveHorizontalMaskHeight(
    inputRegion.bubbleMask,
    expandedRegion,
    horizontalContentHeight,
    fontSize,
  );
  const targetLineCount = Math.max(
    1,
    sourceLines.length,
    preferredLines?.length ?? 0,
    inputRegion.originalLineCount ?? 0,
  );

  if (lines.length > targetLineCount && fontSize > minFontSafetySize) {
    const minAllowed = Math.max(
      minFontSafetySize,
      Math.ceil(estimatedInitialFontSize * 0.3),
    );
    let lo = minAllowed;
    let hi = fontSize - 1;
    let bestFontSize = fontSize;
    let bestLines = lines;
    let bestBreakReasons = lineBreakReasons;
    let bestSegmentIds = lineSegmentIds;
    let bestSegmentSources = lineSegmentSources;
    let bestLetterSpacingScale = letterSpacingScale;
    let bestLineHeightScale = lineHeightScale;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midProfile = estimateHorizontalPreferredProfile(
        measureCtx,
        expandedRegion,
        text,
        contentWidth,
        horizontalContentHeight,
        mid,
        fontFamily,
        preferredLines,
        originalContentHeight,
      );
      measureCtx.font = `${mid}px ${fontFamily}`;
      let candidateLines: HLine[];
      if (preferredLineSegments.length > 0) {
        const horizontalResult = calcHorizontalFromLines(
          measureCtx,
          preferredLineSegments,
          contentWidth,
          mid,
          midProfile.letterSpacingScale,
        );
        candidateLines = horizontalResult.lines;
        if (candidateLines.length <= targetLineCount) {
          bestBreakReasons = horizontalResult.lineBreakReasons;
          bestSegmentIds = horizontalResult.lineSegmentIds;
          bestSegmentSources = horizontalResult.lineSegmentSources;
        }
      } else {
        candidateLines = calcHorizontal(
          measureCtx,
          text,
          contentWidth,
          mid,
          fontFamily,
          midProfile.letterSpacingScale,
        );
        if (candidateLines.length <= targetLineCount) {
          bestBreakReasons = candidateLines.map((_, index) => (
            index === 0 ? 'start' : 'wrap'
          ));
          bestSegmentIds = candidateLines.map(() => 1);
          bestSegmentSources = candidateLines.map(() => 'model');
        }
      }
      if (candidateLines.length <= targetLineCount) {
        bestFontSize = mid;
        bestLines = candidateLines;
        bestLetterSpacingScale = midProfile.letterSpacingScale;
        bestLineHeightScale = midProfile.lineHeightScale;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (bestFontSize !== fontSize) {
      fontSize = bestFontSize;
      lines = bestLines;
      lineBreakReasons = bestBreakReasons;
      lineSegmentIds = bestSegmentIds;
      lineSegmentSources = bestSegmentSources;
      letterSpacingScale = bestLetterSpacingScale;
      lineHeightScale = bestLineHeightScale;
      horizontalContentHeight = resolveHorizontalContentHeight(contentHeight, fontSize);
      horizontalContentHeight = resolveHorizontalMaskHeight(
        inputRegion.bubbleMask,
        expandedRegion,
        horizontalContentHeight,
        fontSize,
      );
    }
  }

  measureCtx.font = `${fontSize}px ${fontFamily}`;
  const strokePadding = resolveHorizontalRenderPadding(
    measureCtx,
    lines,
    fontSize,
    fontFamily,
    letterSpacingScale,
  );
  const alignment = resolveAlignment(expandedRegion, lines.length);
  const debugColumnBoxes = buildHorizontalDebugColumnBoxes(
    lines,
    contentWidth,
    horizontalContentHeight,
    fontSize,
    alignment,
    strokePadding,
    lineHeightScale,
  );

  return {
    expandedRegion,
    text,
    preferredLines,
    sourceLines,
    sourceLineLengths,
    singleLineMaxLength,
    initialFontSize: estimatedInitialFontSize,
    fittedFontSize: fontSize,
    lines,
    lineBreakReasons,
    lineSegmentIds,
    lineSegmentSources,
    contentWidth,
    contentHeight: horizontalContentHeight,
    alignment,
    strokePadding,
    letterSpacingScale,
    lineHeightScale,
    debugColumnBoxes,
    offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
    offscreenHeight: Math.ceil(horizontalContentHeight + strokePadding * 2),
    boxPadding,
  };
}
