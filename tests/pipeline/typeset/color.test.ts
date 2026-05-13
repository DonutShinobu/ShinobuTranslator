import { describe, it, expect } from "vitest";
import { rgbToLab, colorDistance, resolveColors } from "../../../src/pipeline/typeset/color";

describe("rgbToLab", () => {
  it("maps pure black [0,0,0] to Lab [0,0,0]", () => {
    const [L, a, b] = rgbToLab(0, 0, 0);
    expect(L).toBeCloseTo(0, 1);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("maps pure white [255,255,255] to Lab L~100, a~0, b~0", () => {
    const [L, a, b] = rgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 1);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("maps red [255,0,0] to known Lab values (L~53.2, a~80.1, b~67.2)", () => {
    const [L, a, b] = rgbToLab(255, 0, 0);
    // Reference: sRGB red -> CIELAB D65 is approximately (53.23, 80.11, 67.22)
    expect(L).toBeCloseTo(53.2, 0);
    expect(a).toBeCloseTo(80.1, 0);
    expect(b).toBeCloseTo(67.2, 0);
  });

  it("maps green [0,255,0] to known Lab values (L~87.7, a~-86.2, b~83.2)", () => {
    const [L, a, b] = rgbToLab(0, 255, 0);
    expect(L).toBeCloseTo(87.7, 0);
    expect(a).toBeCloseTo(-86.2, 0);
    expect(b).toBeCloseTo(83.2, 0);
  });

  it("maps blue [0,0,255] to known Lab values (L~32.3, a~79.2, b~-108.0)", () => {
    const [L, a, b] = rgbToLab(0, 0, 255);
    expect(L).toBeCloseTo(32.3, 0);
    expect(a).toBeCloseTo(79.2, 0);
    expect(b).toBeCloseTo(-108.0, 0);
  });

  it("maps mid-gray [128,128,128] to Lab L~53.6, a~0, b~0", () => {
    const [L, a, b] = rgbToLab(128, 128, 128);
    expect(L).toBeCloseTo(53.6, 0);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("is consistent: rgbToLab(0,0,0) and rgbToLab(1,1,1) are close", () => {
    const black = rgbToLab(0, 0, 0);
    const nearBlack = rgbToLab(1, 1, 1);
    expect(Math.abs(black[0] - nearBlack[0])).toBeLessThan(1);
  });
});

describe("colorDistance", () => {
  it("returns 0 for identical colors", () => {
    expect(colorDistance([255, 0, 0], [255, 0, 0])).toBeCloseTo(0, 5);
    expect(colorDistance([0, 0, 0], [0, 0, 0])).toBeCloseTo(0, 5);
  });

  it("returns ~100 for black vs white (DeltaE ~100)", () => {
    const d = colorDistance([0, 0, 0], [255, 255, 255]);
    expect(d).toBeCloseTo(100, 0);
  });

  it("returns known distance for red vs green", () => {
    // Red Lab ~ (53.2, 80.1, 67.2), Green Lab ~ (87.7, -86.2, 83.2)
    // DeltaE = sqrt((53.2-87.7)^2 + (80.1+86.2)^2 + (67.2-83.2)^2)
    //        ≈ sqrt(1188 + 27879 + 256) ≈ sqrt(29323) ≈ 171
    const d = colorDistance([255, 0, 0], [0, 255, 0]);
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(200);
  });

  it("returns small distance for similar colors", () => {
    const d = colorDistance([128, 128, 128], [130, 130, 130]);
    expect(d).toBeLessThan(5);
  });

  it("returns moderate distance for black vs mid-gray", () => {
    const d = colorDistance([0, 0, 0], [128, 128, 128]);
    expect(d).toBeCloseTo(53.6, 0);
  });
});

describe("resolveColors", () => {
  it("returns dark fg + white bg by default (no args)", () => {
    const result = resolveColors();
    expect(result.fg).toBe("rgb(17,17,17)");
    expect(result.bg).toBe("rgb(255,255,255)");
    expect(result.fgRgb).toEqual([17, 17, 17]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("passes through clearly different fg/bg without modification", () => {
    const result = resolveColors([0, 0, 0], [255, 255, 255]);
    expect(result.fgRgb).toEqual([0, 0, 0]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("forces bg to white when similar colors and dark fg", () => {
    // Two dark, similar colors: DeltaE < 30, fg average <= 127 -> bg = white
    const result = resolveColors([30, 30, 30], [50, 50, 50]);
    expect(result.fgRgb).toEqual([30, 30, 30]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("forces bg to black when similar colors and light fg", () => {
    // Two light, similar colors: DeltaE < 30, fg average > 127 -> bg = black
    const result = resolveColors([200, 200, 200], [220, 220, 220]);
    expect(result.fgRgb).toEqual([200, 200, 200]);
    expect(result.bgRgb).toEqual([0, 0, 0]);
  });

  it("passes through colors with sufficient contrast (DeltaE >= 30)", () => {
    // Dark fg and bright bg: DeltaE should be well above 30
    const result = resolveColors([0, 0, 0], [200, 200, 200]);
    expect(result.fgRgb).toEqual([0, 0, 0]);
    expect(result.bgRgb).toEqual([200, 200, 200]);
  });

  it("produces valid CSS rgb() strings", () => {
    const result = resolveColors([100, 150, 200], [250, 250, 250]);
    expect(result.fg).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    expect(result.bg).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it("preserves original fg when forcing bg", () => {
    // Similar colors: fg stays as-is, bg is forced
    const result = resolveColors([15, 15, 15], [25, 25, 25]);
    expect(result.fgRgb).toEqual([15, 15, 15]);
    // fg avg = 15 <= 127, so bg forced to white
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("uses provided bgColor only when no fgColor is given", () => {
    const result = resolveColors(undefined, [200, 200, 200]);
    // Default fg is [17,17,17], which is dark, vs bg [200,200,200]
    // DeltaE between [17,17,17] and [200,200,200] is large, so bg passes through
    expect(result.fgRgb).toEqual([17, 17, 17]);
    expect(result.bgRgb).toEqual([200, 200, 200]);
  });

  it("uses default bg when only fgColor is provided with sufficient contrast", () => {
    const result = resolveColors([0, 0, 0]);
    // Default bg is [255,255,255], contrast is high
    expect(result.fgRgb).toEqual([0, 0, 0]);
    expect(result.bgRgb).toEqual([255, 255, 255]);
  });

  it("forces bg when only fgColor is provided and fg is similar to default bg", () => {
    // fg = [240, 240, 240] vs default bg = [255, 255, 255]
    // These are similar: DeltaE will be < 30, fg avg > 127 -> bg forced to black
    const result = resolveColors([240, 240, 240]);
    expect(result.fgRgb).toEqual([240, 240, 240]);
    expect(result.bgRgb).toEqual([0, 0, 0]);
  });
});