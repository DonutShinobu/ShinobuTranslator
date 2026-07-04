import { describe, it, expect } from "vitest";
import {
  grayAt,
  sampleEdgeColors,
  sampleCornerBgColor,
  sampleTextColors,
} from "../../../src/pipeline/ocr/colorSampling";

/**
 * Helper: create a Uint8ClampedArray representing an image of given width/height.
 * All pixels initialized to bgColor. A centered rectangular region is filled
 * with fgColor to simulate text on a background.
 */
function makePixelData(
  width: number,
  height: number,
  bgColor: [number, number, number],
  fgColor: [number, number, number],
  fgRegion?: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);

  // Fill with background color
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    data[idx] = bgColor[0];
    data[idx + 1] = bgColor[1];
    data[idx + 2] = bgColor[2];
    data[idx + 3] = 255; // alpha
  }

  // Fill foreground region if provided
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

function fillRect(
  data: Uint8ClampedArray,
  width: number,
  color: [number, number, number],
  rect: { x: number; y: number; w: number; h: number },
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const idx = (y * width + x) * 4;
      data[idx] = color[0];
      data[idx + 1] = color[1];
      data[idx + 2] = color[2];
      data[idx + 3] = 255;
    }
  }
}

describe("grayAt", () => {
  it("computes grayscale using weighted formula 0.299*R + 0.587*G + 0.114*B", () => {
    // Pure red: 0.299*255 = 76.245
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(grayAt(data, 0)).toBeCloseTo(76.245, 2);

    // Pure green: 0.587*255 = 149.685
    const data2 = new Uint8ClampedArray([0, 255, 0, 255]);
    expect(grayAt(data2, 0)).toBeCloseTo(149.685, 2);

    // Pure blue: 0.114*255 = 29.07
    const data3 = new Uint8ClampedArray([0, 0, 255, 255]);
    expect(grayAt(data3, 0)).toBeCloseTo(29.07, 2);

    // White: 0.299*255 + 0.587*255 + 0.114*255 = 255
    const data4 = new Uint8ClampedArray([255, 255, 255, 255]);
    expect(grayAt(data4, 0)).toBeCloseTo(255, 2);

    // Black
    const data5 = new Uint8ClampedArray([0, 0, 0, 255]);
    expect(grayAt(data5, 0)).toBeCloseTo(0, 2);
  });
});

describe("sampleEdgeColors", () => {
  it("returns blended fgColor darker than background for black text on white background", () => {
    // 20x20 image, white background, black text region in center (5,5)-(15,15)
    // Sobel edge pixels include pixels on both sides of the boundary,
    // so fgColor is a blend of foreground and background at the edges.
    const data = makePixelData(20, 20, [255, 255, 255], [0, 0, 0], {
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });

    const result = sampleEdgeColors(data, 20, 20);
    expect(result).not.toBeNull();
    // fgColor should be significantly darker than the white background (255)
    const [r, g, b] = result!;
    expect(r).toBeLessThan(180);
    expect(g).toBeLessThan(180);
    expect(b).toBeLessThan(180);
  });

  it("returns null for uniform color image (no edges)", () => {
    // Entire image is single color — no gradient above threshold
    const data = makePixelData(10, 10, [128, 128, 128], [128, 128, 128]);
    const result = sampleEdgeColors(data, 10, 10);
    expect(result).toBeNull();
  });

  it("returns null for very small image with no detectable edges", () => {
    // 3x3 uniform image — too small and uniform
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < 9; i++) {
      const idx = i * 4;
      data[idx] = 200;
      data[idx + 1] = 200;
      data[idx + 2] = 200;
      data[idx + 3] = 255;
    }
    const result = sampleEdgeColors(data, 3, 3);
    expect(result).toBeNull();
  });

  it("detects colored foreground at edges", () => {
    // White background with red text in center
    const data = makePixelData(20, 20, [255, 255, 255], [255, 0, 0], {
      x: 6,
      y: 6,
      w: 8,
      h: 8,
    });

    const result = sampleEdgeColors(data, 20, 20);
    expect(result).not.toBeNull();
    // The fgColor at edges should have high red component
    const [r] = result!;
    expect(r).toBeGreaterThan(200);
  });
});

describe("sampleCornerBgColor", () => {
  it("returns white when all four corners are white", () => {
    const data = makePixelData(10, 10, [255, 255, 255], [0, 0, 0], {
      x: 3,
      y: 3,
      w: 4,
      h: 4,
    });

    const result = sampleCornerBgColor(data, 10, 10);
    expect(result).toEqual([255, 255, 255]);
  });

  it("returns average of corner colors", () => {
    // 10x10, manually set corners to different colors
    const data = new Uint8ClampedArray(10 * 10 * 4);
    // Fill all with gray
    for (let i = 0; i < 10 * 10; i++) {
      const idx = i * 4;
      data[idx] = 128;
      data[idx + 1] = 128;
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }

    // Top-left (0,0): red [255,0,0]
    let idx = 0 * 4;
    data[idx] = 255; data[idx + 1] = 0; data[idx + 2] = 0;

    // Top-right (9,0): green [0,255,0]
    idx = (0 * 10 + 9) * 4;
    data[idx] = 0; data[idx + 1] = 255; data[idx + 2] = 0;

    // Bottom-left (0,9): blue [0,0,255]
    idx = (9 * 10 + 0) * 4;
    data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 255;

    // Bottom-right (9,9): white [255,255,255]
    idx = (9 * 10 + 9) * 4;
    data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255;

    // Average: [(255+0+0+255)/4, (0+255+0+255)/4, (0+0+255+255)/4]
    // = [127.5, 127.5, 127.5] → rounded to [128, 128, 128]
    const result = sampleCornerBgColor(data, 10, 10);
    // Check each component is close to 128 (accounting for rounding)
    expect(result[0]).toBeGreaterThanOrEqual(127);
    expect(result[0]).toBeLessThanOrEqual(128);
    expect(result[1]).toBeGreaterThanOrEqual(127);
    expect(result[1]).toBeLessThanOrEqual(128);
    expect(result[2]).toBeGreaterThanOrEqual(127);
    expect(result[2]).toBeLessThanOrEqual(128);
  });

  it("always returns a valid color even for 1x1 image", () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255]);
    const result = sampleCornerBgColor(data, 1, 1);
    // All four corners point to the same pixel
    expect(result).toEqual([100, 150, 200]);
  });
});

describe("sampleTextColors", () => {
  it("keeps black fill and white stroke/background for standard manga text", () => {
    const data = makePixelData(40, 40, [255, 255, 255], [0, 0, 0], {
      x: 14,
      y: 8,
      w: 12,
      h: 24,
    });

    const result = sampleTextColors(data, 40, 40);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeLessThan(40);
    expect(result!.fgColor[1]).toBeLessThan(40);
    expect(result!.fgColor[2]).toBeLessThan(40);
    expect(result!.bgColor[0]).toBeGreaterThan(230);
    expect(result!.bgColor[1]).toBeGreaterThan(230);
    expect(result!.bgColor[2]).toBeGreaterThan(230);
  });

  it("separates white fill and black outline from an orange bubble background", () => {
    const data = makePixelData(48, 48, [248, 196, 148], [248, 196, 148]);
    fillRect(data, 48, [0, 0, 0], { x: 12, y: 6, w: 24, h: 36 });
    fillRect(data, 48, [255, 255, 255], { x: 17, y: 12, w: 14, h: 24 });

    const result = sampleTextColors(data, 48, 48);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeGreaterThan(230);
    expect(result!.fgColor[1]).toBeGreaterThan(230);
    expect(result!.fgColor[2]).toBeGreaterThan(230);
    expect(result!.bgColor[0]).toBeLessThan(40);
    expect(result!.bgColor[1]).toBeLessThan(40);
    expect(result!.bgColor[2]).toBeLessThan(40);
  });

  it("separates white fill and red outline from a warm illustration background", () => {
    const data = makePixelData(48, 48, [252, 172, 121], [252, 172, 121]);
    fillRect(data, 48, [145, 42, 22], { x: 12, y: 6, w: 24, h: 36 });
    fillRect(data, 48, [255, 255, 255], { x: 17, y: 12, w: 14, h: 24 });

    const result = sampleTextColors(data, 48, 48);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeGreaterThan(230);
    expect(result!.fgColor[1]).toBeGreaterThan(230);
    expect(result!.fgColor[2]).toBeGreaterThan(230);
    expect(result!.bgColor[0]).toBeGreaterThan(100);
    expect(result!.bgColor[0]).toBeLessThan(180);
    expect(result!.bgColor[1]).toBeLessThan(80);
    expect(result!.bgColor[2]).toBeLessThan(60);
  });

  it("keeps black fill and white outline on an orange bubble background", () => {
    const data = makePixelData(48, 48, [248, 196, 148], [248, 196, 148]);
    fillRect(data, 48, [255, 255, 255], { x: 12, y: 6, w: 24, h: 36 });
    fillRect(data, 48, [0, 0, 0], { x: 17, y: 12, w: 14, h: 24 });

    const result = sampleTextColors(data, 48, 48);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeLessThan(40);
    expect(result!.fgColor[1]).toBeLessThan(40);
    expect(result!.fgColor[2]).toBeLessThan(40);
    expect(result!.bgColor[0]).toBeGreaterThan(230);
    expect(result!.bgColor[1]).toBeGreaterThan(230);
    expect(result!.bgColor[2]).toBeGreaterThan(230);
  });

  it("keeps orange fill and white outline when the outline touches the background", () => {
    const data = makePixelData(48, 48, [64, 56, 52], [64, 56, 52]);
    fillRect(data, 48, [255, 255, 255], { x: 12, y: 6, w: 24, h: 36 });
    fillRect(data, 48, [232, 116, 44], { x: 17, y: 12, w: 14, h: 24 });

    const result = sampleTextColors(data, 48, 48);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeGreaterThan(200);
    expect(result!.fgColor[0]).toBeLessThan(250);
    expect(result!.fgColor[1]).toBeGreaterThan(80);
    expect(result!.fgColor[1]).toBeLessThan(150);
    expect(result!.fgColor[2]).toBeLessThan(80);
    expect(result!.bgColor[0]).toBeGreaterThan(230);
    expect(result!.bgColor[1]).toBeGreaterThan(230);
    expect(result!.bgColor[2]).toBeGreaterThan(230);
  });

  it("keeps small orange fill when a warm background competes for candidates", () => {
    const data = makePixelData(60, 60, [252, 172, 119], [252, 172, 119]);
    fillRect(data, 60, [255, 255, 255], { x: 19, y: 8, w: 22, h: 44 });
    fillRect(data, 60, [164, 58, 27], { x: 25, y: 15, w: 10, h: 30 });

    const result = sampleTextColors(data, 60, 60);
    expect(result).not.toBeNull();
    expect(result!.fgColor[0]).toBeGreaterThan(120);
    expect(result!.fgColor[0]).toBeLessThan(210);
    expect(result!.fgColor[1]).toBeGreaterThan(30);
    expect(result!.fgColor[1]).toBeLessThan(100);
    expect(result!.fgColor[2]).toBeLessThan(70);
    expect(result!.bgColor[0]).toBeGreaterThan(230);
    expect(result!.bgColor[1]).toBeGreaterThan(230);
    expect(result!.bgColor[2]).toBeGreaterThan(230);
  });

});
