// ---------------------------------------------------------------------------
// Color utility functions for benchmark scripts.
// Re-exports from pipeline source + additional helpers for diagnostic/comparison.
// ---------------------------------------------------------------------------

import { rgbToLab as _rgbToLab, colorDistance as _colorDistance, resolveColors as _resolveColors } from "../../../src/pipeline/typeset/color";
import { sampleEdgeColors as _sampleEdgeColors, sampleCornerBgColor as _sampleCornerBgColor, grayAt as _grayAt } from "../../../src/pipeline/ocr/colorSampling";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { OcrColorResult } from "../../../src/pipeline/ocr/color";
import type { ColorFixture } from "./color-types";

export const ROOT = resolve(import.meta.dirname, "../../../..");
export const FIXTURES_DIR = join(ROOT, "benchmark/color/fixtures");
export const REPORTS_DIR = join(ROOT, "benchmark/reports");

// Re-export under their original names
export const rgbToLab = _rgbToLab;
export const colorDistance = _colorDistance;
export const resolveColors = _resolveColors;
export const sampleEdgeColors = _sampleEdgeColors;
export const sampleCornerBgColor = _sampleCornerBgColor;
export const grayAt = _grayAt;

/**
 * DeltaE (CIE76) between two RGB colors.
 * Alias for colorDistance to make the intent explicit in diagnostic scripts.
 */
export function deltaE(
  c1: [number, number, number],
  c2: [number, number, number],
): number {
  return _colorDistance(c1, c2);
}

/**
 * Check whether fg/bg colors constitute a "gray failure" (DeltaE < 30).
 */
export function isGrayFailure(
  fg: [number, number, number],
  bg: [number, number, number],
): boolean {
  return _colorDistance(fg, bg) < 30;
}

/**
 * Crop a rectangular region from pixel data.
 * Returns the cropped RGBA data and its dimensions.
 */
export function cropRegion(
  pixelData: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  bbox: [number, number, number, number],
): { data: Uint8ClampedArray; width: number; height: number } {
  const [bx, by, bw, bh] = bbox;
  // Clamp bbox to image bounds
  const x0 = Math.max(0, Math.floor(bx));
  const y0 = Math.max(0, Math.floor(by));
  const x1 = Math.min(imageWidth, Math.floor(bx + bw));
  const y1 = Math.min(imageHeight, Math.floor(by + bh));
  const cw = x1 - x0;
  const ch = y1 - y0;

  if (cw <= 0 || ch <= 0) {
    return { data: new Uint8ClampedArray(0), width: 0, height: 0 };
  }

  const cropped = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOffset = ((y0 + row) * imageWidth + x0) * 4;
    const dstOffset = row * cw * 4;
    cropped.set(pixelData.subarray(srcOffset, srcOffset + cw * 4), dstOffset);
  }

  return { data: cropped, width: cw, height: ch };
}

// ---------------------------------------------------------------------------
// Re-implement extractColorsFromOutputs (current/buggy version) for benchmark.
// This is NOT exported from src/pipeline/ocr/color.ts, so we copy it here.
// When hasBg=false, it accumulates fg values into the bg accumulator (the bug).
// ---------------------------------------------------------------------------

export type ExtractColorsCountedResult = OcrColorResult & {
  cntFg: number;
  cntBg: number;
  totalSteps: number;
};

export function extractColorsFromOutputsCurrent(
  fg: Float32Array,
  bg: Float32Array,
  fgInd: Float32Array,
  bgInd: Float32Array,
  stepsPerSample: number,
  sampleOffset: number,
  tokenCount: number,
): ExtractColorsCountedResult | null {
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
    } else {
      // BUG: when hasBg=false, fg values are accumulated into bg accumulator
      br += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntBg += 1;
    }
  }

  const fgColor: [number, number, number] = [
    cntFg > 0 ? Math.round(fr / cntFg) : 0,
    cntFg > 0 ? Math.round(fgCh / cntFg) : 0,
    cntFg > 0 ? Math.round(fb / cntFg) : 0,
  ];
  const bgColor: [number, number, number] = [
    cntBg > 0 ? Math.round(br / cntBg) : 0,
    cntBg > 0 ? Math.round(bgCh / cntBg) : 0,
    cntBg > 0 ? Math.round(bb / cntBg) : 0,
  ];
  return { fgColor, bgColor, cntFg, cntBg, totalSteps: maxSteps };
}

/**
 * Create synthetic OCR model data for testing.
 * Simulates the hasBg=false bug scenario that causes gray text.
 * All steps have valid fg predictions but no valid bg predictions.
 */
export function createSyntheticOcrData(maxSteps: number): {
  fg: Float32Array;
  bg: Float32Array;
  fgInd: Float32Array;
  bgInd: Float32Array;
} {
  const fg = new Float32Array(maxSteps * 3);
  const bg = new Float32Array(maxSteps * 3);
  const fgInd = new Float32Array(maxSteps * 2);
  const bgInd = new Float32Array(maxSteps * 2);

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

  return { fg, bg, fgInd, bgInd };
}

/**
 * Load color fixture annotations from the fixtures directory.
 */
export function loadFixtures(): ColorFixture[] {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`fixtures 目录不存在: ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("fixtures 目录中没有 JSON 标注文件。请先添加测试数据。");
    process.exit(1);
  }

  const fixtures: ColorFixture[] = [];
  for (const file of files) {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf-8");
    const fixture: ColorFixture = JSON.parse(raw);
    fixtures.push(fixture);
  }
  return fixtures;
}