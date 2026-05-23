// ---------------------------------------------------------------------------
// Algorithm A: Fixed extractColorsFromOutputs where hasBg=false
// no longer accumulates fg values into the bg accumulator.
// ---------------------------------------------------------------------------
//
// Original bug (lines 72-74 in color.ts): When hasBg is false, fg RGB values
// get accumulated into the bg accumulator, causing bg to converge toward fg
// and producing gray results when OCR model has no valid bg prediction.
//
// Fix: When hasBg is false, skip that step's bg accumulation entirely.
// The bg color is then computed only from steps where OCR model actually
// predicted a bg value. If no steps have valid bg, fall back to white (255,255,255).

export type AlgAColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
  cntFg: number;
  cntBg: number;
  totalSteps: number;
};

/**
 * Fixed extractColorsFromOutputs — Algorithm A.
 * When hasBg is false, the step is skipped for bg accumulation entirely.
 * If no steps have valid bg, bgColor defaults to [255, 255, 255] (white).
 */
export function extractColorsFromOutputsAlgA(
  fg: Float32Array,
  bg: Float32Array,
  fgInd: Float32Array,
  bgInd: Float32Array,
  stepsPerSample: number,
  sampleOffset: number,
  tokenCount: number,
): AlgAColorResult | null {
  const maxSteps = Math.min(tokenCount, stepsPerSample);
  if (maxSteps <= 0) {
    return null;
  }

  let fr = 0;
  let fgCh = 0;
  let fb = 0;
  let br = 0;
  let bgCh = 0;
  let bb = 0;
  let cntFg = 0;
  let cntBg = 0;

  for (let t = 0; t < maxSteps; t += 1) {
    const fgBase = (sampleOffset + t) * 3;
    const bgBase = (sampleOffset + t) * 3;
    const fgIndBase = (sampleOffset + t) * 2;
    const bgIndBase = (sampleOffset + t) * 2;
    const hasFg = fgInd[fgIndBase + 1] > fgInd[fgIndBase];
    const hasBg = bgInd[bgIndBase + 1] > bgInd[bgIndBase];

    if (hasFg) {
      fr += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      fgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      fb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntFg += 1;
    }

    // Algorithm A fix: only accumulate bg when hasBg is true.
    // Skip bg accumulation for steps where OCR model has no valid bg prediction.
    if (hasBg) {
      br += Math.round(Math.max(0, Math.min(1, bg[bgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, bg[bgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, bg[bgBase + 2])) * 255);
      cntBg += 1;
    }
  }

  const fgColor: [number, number, number] = [
    cntFg > 0 ? Math.round(fr / cntFg) : 0,
    cntFg > 0 ? Math.round(fgCh / cntFg) : 0,
    cntFg > 0 ? Math.round(fb / cntFg) : 0,
  ];
  // If no valid bg steps, fall back to white
  const bgColor: [number, number, number] =
    cntBg > 0
      ? [
          Math.round(br / cntBg),
          Math.round(bgCh / cntBg),
          Math.round(bb / cntBg),
        ]
      : [255, 255, 255];

  return {
    fgColor,
    bgColor,
    cntFg,
    cntBg,
    totalSteps: maxSteps,
  };
}