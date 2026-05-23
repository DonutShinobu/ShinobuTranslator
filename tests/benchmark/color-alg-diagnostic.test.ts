// ---------------------------------------------------------------------------
// Vitest tests for color diagnostic/comparison utilities.
// Tests Algorithm A fix, Algorithm D, and color utility functions.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { extractColorsFromOutputsAlgA } from "../../benchmark/color/src/alg-a-fix-hasbg";
import { histogramBimodal } from "../../benchmark/color/src/alg-d-histogram-bimodal";
import {
  rgbToLab,
  colorDistance,
  deltaE,
  isGrayFailure,
  resolveColors,
  cropRegion,
} from "../../benchmark/color/src/color-utils";

// ---------------------------------------------------------------------------
// color-utils tests
// ---------------------------------------------------------------------------

describe("rgbToLab", () => {
  it("converts pure black to Lab [0, 0, 0]", () => {
    const lab = rgbToLab(0, 0, 0);
    expect(lab[0]).toBeCloseTo(0, 1);
    expect(lab[1]).toBeCloseTo(0, 1);
    expect(lab[2]).toBeCloseTo(0, 1);
  });

  it("converts pure white to Lab [100, 0, 0]", () => {
    const lab = rgbToLab(255, 255, 255);
    expect(lab[0]).toBeCloseTo(100, 0);
    expect(lab[1]).toBeCloseTo(0, 1);
    expect(lab[2]).toBeCloseTo(0, 1);
  });

  it("converts pure red correctly", () => {
    const lab = rgbToLab(255, 0, 0);
    expect(lab[0]).toBeCloseTo(53.23, 1);
    expect(lab[1]).toBeCloseTo(80.11, 1);
    expect(lab[2]).toBeCloseTo(67.22, 1);
  });
});

describe("colorDistance / deltaE", () => {
  it("returns 0 for identical colors", () => {
    expect(colorDistance([128, 128, 128], [128, 128, 128])).toBeCloseTo(0, 2);
    expect(deltaE([128, 128, 128], [128, 128, 128])).toBeCloseTo(0, 2);
  });

  it("returns large DeltaE for black vs white", () => {
    const d = colorDistance([0, 0, 0], [255, 255, 255]);
    expect(d).toBeCloseTo(100, 0);
  });

  it("returns small DeltaE for similar gray colors", () => {
    const d = colorDistance([120, 120, 120], [130, 130, 130]);
    expect(d).toBeLessThan(10);
  });
});

describe("isGrayFailure", () => {
  it("returns true when fg/bg DeltaE < 30", () => {
    // Two very similar gray colors
    expect(isGrayFailure([128, 128, 128], [130, 130, 130])).toBe(true);
  });

  it("returns false when fg/bg DeltaE >= 30", () => {
    // Black vs white
    expect(isGrayFailure([0, 0, 0], [255, 255, 255])).toBe(false);
  });

  it("returns false for moderate contrast", () => {
    // Dark gray vs light gray — DeltaE ~50+
    expect(isGrayFailure([50, 50, 50], [200, 200, 200])).toBe(false);
  });
});

describe("resolveColors", () => {
  it("defaults to black fg and white bg when no colors provided", () => {
    const result = resolveColors(undefined, undefined);
    expect(result.fgRgb).toEqual([17, 17, 17]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("triggers safety net when fg/bg are too similar", () => {
    // fg and bg both gray — DeltaE < 30
    const result = resolveColors([128, 128, 128], [130, 130, 130]);
    // Safety net: fg is light (avg > 127), so bg becomes black
    expect(result.bgRgb).toEqual([0, 0, 0]);
  });

  it("keeps colors when fg/bg have sufficient contrast", () => {
    const result = resolveColors([0, 0, 0], [255, 255, 255]);
    expect(result.fgRgb).toEqual([0, 0, 0]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });
});

describe("cropRegion", () => {
  it("crops a valid region from pixel data", () => {
    // 10x10 image, all pixels white
    const data = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < 100; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    const result = cropRegion(data, 10, 10, [2, 2, 3, 3]);
    expect(result.width).toBe(3);
    expect(result.height).toBe(3);
    // Should have 9 pixels * 4 channels = 36 bytes
    expect(result.data.length).toBe(36);
    // All cropped pixels should still be white
    expect(result.data[0]).toBe(255);
  });

  it("clamps bbox to image bounds", () => {
    const data = new Uint8ClampedArray(10 * 10 * 4);
    const result = cropRegion(data, 10, 10, [-5, -5, 20, 20]);
    // Clamped to [0,0,10,10] → full image
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });

  it("returns empty result for zero-size crop", () => {
    const data = new Uint8ClampedArray(10 * 10 * 4);
    const result = cropRegion(data, 10, 10, [15, 15, 5, 5]);
    // bbox entirely outside image
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Algorithm A tests
// ---------------------------------------------------------------------------

describe("extractColorsFromOutputsAlgA", () => {
  it("returns null when maxSteps <= 0", () => {
    const fg = new Float32Array(0);
    const bg = new Float32Array(0);
    const fgInd = new Float32Array(0);
    const bgInd = new Float32Array(0);
    const result = extractColorsFromOutputsAlgA(fg, bg, fgInd, bgInd, 0, 0, 0);
    expect(result).toBeNull();
  });

  it("separates fg/bg correctly when hasBg=false for all steps", () => {
    // The key bug scenario: OCR model has valid fg predictions but no valid bg
    // Current algorithm: bg accumulator gets fg values → gray result
    // Algorithm A: bg accumulator stays empty → bg defaults to white
    const maxSteps = 5;
    const fg = new Float32Array(maxSteps * 3);
    const bg = new Float32Array(maxSteps * 3);
    const fgInd = new Float32Array(maxSteps * 2);
    const bgInd = new Float32Array(maxSteps * 2);

    // Dark fg (R=51, G=51, B=51) and bright bg predictions
    // but bg is invalid (hasBg=false for all steps)
    for (let t = 0; t < maxSteps; t++) {
      fg[t * 3] = 0.2;
      fg[t * 3 + 1] = 0.2;
      fg[t * 3 + 2] = 0.2;
      bg[t * 3] = 0.9;
      bg[t * 3 + 1] = 0.9;
      bg[t * 3 + 2] = 0.9;
      fgInd[t * 2] = 0.01;
      fgInd[t * 2 + 1] = 0.99; // hasFg=true
      bgInd[t * 2] = 0.99;
      bgInd[t * 2 + 1] = 0.01; // hasBg=false
    }

    const result = extractColorsFromOutputsAlgA(
      fg, bg, fgInd, bgInd, maxSteps, 0, maxSteps,
    );

    expect(result).not.toBeNull();
    // fg should be dark (~51 per channel)
    expect(result!.fgColor[0]).toBeCloseTo(51, 0);
    expect(result!.fgColor[1]).toBeCloseTo(51, 0);
    expect(result!.fgColor[2]).toBeCloseTo(51, 0);
    // bg should default to white [255, 255, 255] since no valid bg steps
    expect(result!.bgColor).toEqual([255, 255, 255]);
    // cntBg should be 0 since no steps had hasBg=true
    expect(result!.cntBg).toBe(0);
  });

  it("correctly accumulates bg when hasBg=true", () => {
    const maxSteps = 3;
    const fg = new Float32Array(maxSteps * 3);
    const bg = new Float32Array(maxSteps * 3);
    const fgInd = new Float32Array(maxSteps * 2);
    const bgInd = new Float32Array(maxSteps * 2);

    for (let t = 0; t < maxSteps; t++) {
      fg[t * 3] = 0.1;
      fg[t * 3 + 1] = 0.1;
      fg[t * 3 + 2] = 0.1;
      bg[t * 3] = 0.9;
      bg[t * 3 + 1] = 0.9;
      bg[t * 3 + 2] = 0.9;
      fgInd[t * 2] = 0.01;
      fgInd[t * 2 + 1] = 0.99; // hasFg=true
      bgInd[t * 2] = 0.01;
      bgInd[t * 2 + 1] = 0.99; // hasBg=true
    }

    const result = extractColorsFromOutputsAlgA(
      fg, bg, fgInd, bgInd, maxSteps, 0, maxSteps,
    );

    expect(result).not.toBeNull();
    expect(result!.cntFg).toBe(3);
    expect(result!.cntBg).toBe(3);
    // fg ~26, bg ~229 (0.9*255=229.5, Float32Array rounding may produce 229)
    expect(result!.fgColor[0]).toBeCloseTo(26, -1);
    expect(result!.bgColor[0]).toBeGreaterThan(220);
  });

  it("keeps valid bg steps when some have hasBg=true and some false", () => {
    const maxSteps = 4;
    const fg = new Float32Array(maxSteps * 3);
    const bg = new Float32Array(maxSteps * 3);
    const fgInd = new Float32Array(maxSteps * 2);
    const bgInd = new Float32Array(maxSteps * 2);

    // Steps 0,1: hasBg=true (bright bg ~230)
    // Steps 2,3: hasBg=false (should NOT pollute bg accumulator)
    for (let t = 0; t < maxSteps; t++) {
      fg[t * 3] = 0.2;
      fg[t * 3 + 1] = 0.2;
      fg[t * 3 + 2] = 0.2;
      bg[t * 3] = 0.9;
      bg[t * 3 + 1] = 0.9;
      bg[t * 3 + 2] = 0.9;
      fgInd[t * 2] = 0.01;
      fgInd[t * 2 + 1] = 0.99; // hasFg=true
      if (t < 2) {
        bgInd[t * 2] = 0.01;
        bgInd[t * 2 + 1] = 0.99; // hasBg=true
      } else {
        bgInd[t * 2] = 0.99;
        bgInd[t * 2 + 1] = 0.01; // hasBg=false
      }
    }

    const result = extractColorsFromOutputsAlgA(
      fg, bg, fgInd, bgInd, maxSteps, 0, maxSteps,
    );

    expect(result).not.toBeNull();
    // Only 2 steps have valid bg
    expect(result!.cntBg).toBe(2);
    // bg should be ~229 (0.9*255=229.5, Float32Array rounding may vary)
    expect(result!.bgColor[0]).toBeGreaterThan(220);
    expect(result!.bgColor[1]).toBeGreaterThan(220);
    expect(result!.bgColor[2]).toBeGreaterThan(220);
  });
});

// ---------------------------------------------------------------------------
// Algorithm D tests
// ---------------------------------------------------------------------------

describe("histogramBimodal", () => {
  function makePixelData(
    width: number,
    height: number,
    bgColor: [number, number, number],
    fgColor: [number, number, number],
    fgRegion?: { x: number; y: number; w: number; h: number },
  ): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      data[idx] = bgColor[0];
      data[idx + 1] = bgColor[1];
      data[idx + 2] = bgColor[2];
      data[idx + 3] = 255;
    }
    if (fgRegion) {
      for (let y = fgRegion.y; y < fgRegion.y + fgRegion.h; y++) {
        for (let x = fgRegion.x; x < fgRegion.x + fgRegion.w; x++) {
          const idx = (y * width + x) * 4;
          data[idx] = fgColor[0];
          data[idx + 1] = fgColor[1];
          data[idx + 2] = fgColor[2];
          data[idx + 3] = 255;
        }
      }
    }
    return data;
  }

  it("identifies black fg on white bg from bimodal histogram", () => {
    // 40x40, white bg, black text in center (10,10)-(30,30)
    const data = makePixelData(40, 40, [255, 255, 255], [0, 0, 0], {
      x: 10, y: 10, w: 20, h: 20,
    });
    const result = histogramBimodal(data, 40, 40);
    expect(result).not.toBeNull();
    // bg should be near white, fg should be near black
    expect(result!.bgColor[0]).toBeGreaterThan(200);
    expect(result!.fgColor[0]).toBeLessThan(80);
  });

  it("identifies colored fg on colored bg", () => {
    // Light cream bg, dark red text
    const data = makePixelData(40, 40, [250, 245, 240], [200, 50, 50], {
      x: 10, y: 10, w: 20, h: 20,
    });
    const result = histogramBimodal(data, 40, 40);
    expect(result).not.toBeNull();
    // bg should be lighter, fg should be darker/redder
    expect(result!.bgColor[0]).toBeGreaterThan(result!.fgColor[0]);
  });

  it("returns null for very small images", () => {
    const data = makePixelData(2, 2, [128, 128, 128], [128, 128, 128]);
    const result = histogramBimodal(data, 2, 2);
    expect(result).toBeNull();
  });

  it("handles uniform color image (single peak)", () => {
    // Entire image is one color — should still return a result
    // (single peak means fg==bg, which will be caught by gray failure check)
    const data = makePixelData(20, 20, [128, 128, 128], [128, 128, 128]);
    const result = histogramBimodal(data, 20, 20);
    // Should return a result (even if both colors are similar)
    expect(result).not.toBeNull();
  });

  it("identifies white fg on dark bg (inverted contrast)", () => {
    // Dark bg with light text — this is an uncommon manga scenario.
    // Algorithm D uses "brighter peak = bg" heuristic which works for most manga
    // (light bg, dark fg). For this inverted case, the algorithm will assign
    // the bright peak as bg, so it reports fg=dark and bg=bright.
    // This is a known limitation of the brightness-based heuristic.
    const data = makePixelData(40, 40, [30, 30, 30], [240, 240, 240], {
      x: 10, y: 10, w: 20, h: 20,
    });
    const result = histogramBimodal(data, 40, 40);
    expect(result).not.toBeNull();
    // Due to "brighter = bg" heuristic, the bright peak is assigned as bg
    // and the dark peak is assigned as fg. This is incorrect for inverted contrast
    // but is the expected behavior of the algorithm.
    expect(result!.bgColor[0]).toBeGreaterThan(180);
    expect(result!.fgColor[0]).toBeLessThan(80);
  });
});