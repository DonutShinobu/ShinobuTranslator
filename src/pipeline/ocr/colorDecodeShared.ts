export type OcrColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

export function extractColorsFromOutputs(
  fg: Float32Array,
  bg: Float32Array,
  fgInd: Float32Array,
  bgInd: Float32Array,
  stepsPerSample: number,
  sampleOffset: number,
  tokenCount: number
): OcrColorResult | null {
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
    if (hasBg) {
      br += Math.round(Math.max(0, Math.min(1, bg[bgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, bg[bgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, bg[bgBase + 2])) * 255);
      cntBg += 1;
    }
  }

  return {
    fgColor: [
      cntFg > 0 ? Math.round(fr / cntFg) : 0,
      cntFg > 0 ? Math.round(fgCh / cntFg) : 0,
      cntFg > 0 ? Math.round(fb / cntFg) : 0
    ],
    bgColor: [
      cntBg > 0 ? Math.round(br / cntBg) : 0,
      cntBg > 0 ? Math.round(bgCh / cntBg) : 0,
      cntBg > 0 ? Math.round(bb / cntBg) : 0
    ]
  };
}
