/**
 * Color sampling utilities for OCR text regions.
 *
 * Uses Sobel edge detection to sample foreground color from high-gradient
 * pixels, and averages corner pixels for background color.
 */

/** Grayscale value at pixel index using weighted formula. */
export function grayAt(data: Uint8ClampedArray, idx: number): number {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

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
): [number, number, number] | null {
  if (width < 3 || height < 3) return null;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Apply Sobel kernels over 3x3 neighborhood
      let gx = 0;
      let gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
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
        count++;
      }
    }
  }

  if (count === 0) return null;

  return [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)];
}

/**
 * Sample background color by averaging the four corner pixels.
 * Always returns a valid color.
 */
export function sampleCornerBgColor(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): [number, number, number] {
  const corners = [
    (0 * width + 0) * 4,                        // top-left
    (0 * width + (width - 1)) * 4,               // top-right
    ((height - 1) * width + 0) * 4,              // bottom-left
    ((height - 1) * width + (width - 1)) * 4,    // bottom-right
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