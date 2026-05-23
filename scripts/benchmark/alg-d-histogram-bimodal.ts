// ---------------------------------------------------------------------------
// Algorithm D: Pixel histogram bimodal method.
// Finds two peaks in region crop pixel RGB histogram as fg/bg.
// No dependency on OCR model output or Sobel edge detection.
// ---------------------------------------------------------------------------

export type AlgDColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

/**
 * Compute a grayscale histogram of pixel data (256 bins).
 * Uses the weighted grayscale formula: 0.299*R + 0.587*G + 0.114*B.
 */
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

/**
 * Apply a simple smoothing kernel (3-bin moving average) to a histogram.
 */
function smoothHistogram(hist: number[]): number[] {
  const smoothed = new Float64Array(hist.length);
  for (let i = 0; i < hist.length; i++) {
    const prev = i > 0 ? hist[i - 1] : 0;
    const next = i < hist.length - 1 ? hist[i + 1] : 0;
    smoothed[i] = (prev + hist[i] + next) / 3;
  }
  return Array.from(smoothed);
}

/**
 * Find the top two peaks in a histogram.
 *
 * Strategy: Find the bin with the highest count (dominant peak). Then find the
 * bin with the highest count that is at least 30 bins away from the dominant peak
 * (secondary peak). If no such bin exists, find the second-highest overall.
 *
 * Returns the two peaks with peak1 being brighter (higher bin value → bg)
 * and peak2 being darker (lower bin value → fg).
 */
function findTwoPeaks(hist: number[]): { peak1: number; peak2: number } | null {
  // Find the bin with the maximum count
  let maxBin = 0;
  let maxCount = hist[0];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i] > maxCount) {
      maxBin = i;
      maxCount = hist[i];
    }
  }

  // Find the secondary peak: the bin with highest count that is at least
  // 30 bins away from the dominant peak
  let secondBin = -1;
  let secondCount = -1;
  for (let i = 0; i < hist.length; i++) {
    if (Math.abs(i - maxBin) >= 30 && hist[i] > secondCount) {
      secondBin = i;
      secondCount = hist[i];
    }
  }

  if (secondBin === -1) {
    // No well-separated second peak found.
    // Try finding the second-highest bin regardless of distance.
    let altBin = -1;
    let altCount = -1;
    for (let i = 0; i < hist.length; i++) {
      if (i !== maxBin && hist[i] > altCount) {
        altBin = i;
        altCount = hist[i];
      }
    }

    if (altBin === -1) {
      // All bins have zero count — return null
      return null;
    }
    secondBin = altBin;
  }

  // Sort by bin value: peak1 = brighter (bg), peak2 = darker (fg)
  const sorted = [maxBin, secondBin].sort((a, b) => b - a);
  return { peak1: sorted[0], peak2: sorted[1] };
}

/**
 * Compute the average RGB color of pixels whose grayscale falls within a range.
 */
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
    // Fall back to the gray value converted to RGB
    return [grayCenter, grayCenter, grayCenter];
  }

  return [
    Math.round(sumR / count),
    Math.round(sumG / count),
    Math.round(sumB / count),
  ];
}

/**
 * Algorithm D: Pixel histogram bimodal method.
 *
 * Computes a grayscale histogram of the region crop pixels, smooths it,
 * finds two peaks (brightest = bg, darkest = fg), then averages the RGB
 * values of pixels near each peak to get the actual fg/bg colors.
 *
 * Does not depend on OCR model output or Sobel edge detection.
 */
export function histogramBimodal(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
): AlgDColorResult | null {
  const pixelCount = width * height;
  if (pixelCount < 8) {
    return null;
  }

  const rawHist = computeGrayHistogram(pixelData, pixelCount);
  // Smooth twice to reduce noise
  const smoothed = smoothHistogram(smoothHistogram(rawHist));

  const peaks = findTwoPeaks(smoothed);
  if (!peaks) {
    return null;
  }

  // peak1 is brighter (higher bin value) → bg
  // peak2 is darker (lower bin value) → fg
  // Average RGB of pixels near each peak (±15 bins)
  const bgColor = averageRgbInRange(pixelData, pixelCount, peaks.peak1, 15);
  const fgColor = averageRgbInRange(pixelData, pixelCount, peaks.peak2, 15);

  return { fgColor, bgColor };
}