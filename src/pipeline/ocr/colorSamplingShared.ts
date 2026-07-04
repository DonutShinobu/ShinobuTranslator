export type RgbColor = [number, number, number];

/** Grayscale value at pixel index using weighted formula. */
export function grayAt(data: Uint8ClampedArray, idx: number): number {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

/**
 * Sample background color by averaging the four corner pixels.
 * Always returns a valid color.
 */
export function sampleCornerBgColor(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): RgbColor {
  const corners = [
    (0 * width + 0) * 4,
    (0 * width + (width - 1)) * 4,
    ((height - 1) * width + 0) * 4,
    ((height - 1) * width + (width - 1)) * 4,
  ];

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const idx of corners) {
    sumR += pixelData[idx];
    sumG += pixelData[idx + 1];
    sumB += pixelData[idx + 2];
  }

  return [Math.round(sumR / 4), Math.round(sumG / 4), Math.round(sumB / 4)];
}
