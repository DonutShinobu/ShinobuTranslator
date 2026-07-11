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
