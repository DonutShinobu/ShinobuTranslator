import { describe, it, expect } from "vitest";
import { queryMaskMaxY } from "./typesetGeometry";

function createMask(width: number, height: number, fillFn: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (fillFn(x, y)) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 255;
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("queryMaskMaxY", () => {
  it("returns yStart when first row is already outside mask", () => {
    const mask = createMask(100, 100, () => false);
    expect(queryMaskMaxY(mask, 10, 20, 50)).toBe(50);
  });

  it("returns mask bottom when entire column is inside mask", () => {
    const mask = createMask(100, 100, () => true);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(99);
  });

  it("stops at the first row where all pixels are outside", () => {
    const mask = createMask(100, 100, (_x, y) => y < 60);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(59);
  });

  it("handles rounded bubble shape — narrower columns stop earlier", () => {
    const mask = createMask(100, 100, (x, y) => {
      return Math.hypot(x - 50, y - 50) < 40;
    });
    const centerMaxY = queryMaskMaxY(mask, 45, 55, 20);
    const edgeMaxY = queryMaskMaxY(mask, 80, 90, 20);
    expect(centerMaxY).toBeGreaterThan(edgeMaxY);
  });

  it("clamps xStart/xEnd to mask bounds", () => {
    const mask = createMask(50, 50, () => true);
    expect(queryMaskMaxY(mask, 40, 60, 0)).toBe(49);
  });
});
