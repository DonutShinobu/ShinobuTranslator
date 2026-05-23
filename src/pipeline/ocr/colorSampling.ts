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

function computeGrayHistogram(
  pixelData: Uint8ClampedArray,
  pixelCount: number,
): number[] {
  const bins = new Float64Array(256);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const gray = Math.round(
      0.299 * pixelData[idx] +
      0.587 * pixelData[idx + 1] +
      0.114 * pixelData[idx + 2],
    );
    bins[Math.min(255, Math.max(0, gray))] += 1;
  }
  return Array.from(bins);
}

function smoothHistogram(hist: number[]): number[] {
  const smoothed = new Float64Array(hist.length);
  for (let i = 0; i < hist.length; i++) {
    const prev = i > 0 ? hist[i - 1] : 0;
    const next = i < hist.length - 1 ? hist[i + 1] : 0;
    smoothed[i] = (prev + hist[i] + next) / 3;
  }
  return Array.from(smoothed);
}

function findTwoPeaks(hist: number[]): { peak1: number; peak2: number } | null {
  let maxBin = 0;
  let maxCount = hist[0];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i] > maxCount) {
      maxBin = i;
      maxCount = hist[i];
    }
  }

  let secondBin = -1;
  let secondCount = -1;
  for (let i = 0; i < hist.length; i++) {
    if (Math.abs(i - maxBin) >= 30 && hist[i] > secondCount) {
      secondBin = i;
      secondCount = hist[i];
    }
  }

  if (secondBin === -1) {
    let altBin = -1;
    let altCount = -1;
    for (let i = 0; i < hist.length; i++) {
      if (i !== maxBin && hist[i] > altCount) {
        altBin = i;
        altCount = hist[i];
      }
    }
    if (altBin === -1) return null;
    secondBin = altBin;
  }

  const sorted = [maxBin, secondBin].sort((a, b) => b - a);
  return { peak1: sorted[0], peak2: sorted[1] };
}

function averageRgbInRange(
  pixelData: Uint8ClampedArray,
  pixelCount: number,
  grayCenter: number,
  grayRange: number,
): [number, number, number] {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  const lo = grayCenter - grayRange;
  const hi = grayCenter + grayRange;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const gray = 0.299 * pixelData[idx] +
      0.587 * pixelData[idx + 1] +
      0.114 * pixelData[idx + 2];

    if (gray >= lo && gray <= hi) {
      sumR += pixelData[idx];
      sumG += pixelData[idx + 1];
      sumB += pixelData[idx + 2];
      count += 1;
    }
  }

  if (count === 0) {
    return [grayCenter, grayCenter, grayCenter];
  }

  return [
    Math.round(sumR / count),
    Math.round(sumG / count),
    Math.round(sumB / count),
  ];
}

/**
 * Histogram bimodal method: finds two peaks in grayscale histogram as fg/bg.
 * Returns null if no well-separated peaks found or pixel count too small.
 */
export function histogramBimodal(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): { fgColor: [number, number, number]; bgColor: [number, number, number] } | null {
  const pixelCount = width * height;
  if (pixelCount < 8) return null;

  const rawHist = computeGrayHistogram(pixelData, pixelCount);
  const smoothed = smoothHistogram(smoothHistogram(rawHist));

  const peaks = findTwoPeaks(smoothed);
  if (!peaks) return null;

  const bgColor = averageRgbInRange(pixelData, pixelCount, peaks.peak1, 15);
  const fgColor = averageRgbInRange(pixelData, pixelCount, peaks.peak2, 15);

  return { fgColor, bgColor };
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