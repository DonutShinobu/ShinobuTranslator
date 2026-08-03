/**
 * Color sampling utilities for OCR text regions.
 *
 * The main sampler separates up to three pixel candidates: image background,
 * text fill, and outline/stroke. This avoids treating colorful speech bubbles
 * as text color when white text has a dark or red outline.
 */

import { sampleTextColors } from "./colorSamplingCandidates";
import { grayAt, sampleCornerBgColor } from "./colorSamplingShared";
import type { RgbColor } from "./colorSamplingShared";

export { grayAt, sampleCornerBgColor, sampleTextColors };

const SOBEL_THRESHOLD = 30;

// Sobel 3x3 kernels
const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/**
 * Sobel edge detection color sampling.
 *
 * Computes gradient on the cropped quad region. Pixels with gradient >= threshold
 * are considered edge pixels. Returns the mean color of those pixels as fgColor.
 * Returns null if no edge pixels are found.
 */
export function sampleEdgeColors(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): RgbColor | null {
  if (width < 3 || height < 3) return null;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let gx = 0;
      let gy = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const pixIdx = ((y + ky) * width + (x + kx)) * 4;
          const gray = grayAt(pixelData, pixIdx);
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += gray * sobelX[ki];
          gy += gray * sobelY[ki];
        }
      }
      const gradient = Math.sqrt(gx * gx + gy * gy);

      if (gradient >= SOBEL_THRESHOLD) {
        const idx = (y * width + x) * 4;
        sumR += pixelData[idx];
        sumG += pixelData[idx + 1];
        sumB += pixelData[idx + 2];
        count += 1;
      }
    }
  }

  if (count === 0) return null;
  return [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)];
}

/**
 * Backwards-compatible export name for benchmark scripts.
 * The implementation now uses the unified three-candidate sampler.
 */
export function histogramBimodal(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): { fgColor: RgbColor; bgColor: RgbColor } | null {
  return sampleTextColors(pixelData, width, height);
}
