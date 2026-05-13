import { describe, it, expect, vi } from "vitest";
import { rectToQuad, inferDirection, intersectsOrNear, mergeRects, connectedComponents } from "../../../src/pipeline/detect/onnxDetect";
import type { Rect } from "../../../src/types";

// onnxDetect.ts imports onnxruntime-web/all at module level for non-pure functions.
// Mock it so the module can load without a browser environment.
vi.mock("onnxruntime-web/all", () => ({
  InferenceSession: {},
  Tensor: class Tensor {
    data: unknown;
    dims: number[];
    type: string;
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
}));

describe("rectToQuad", () => {
  it("converts a Rect to TL/TR/BR/BL quad points", () => {
    const box: Rect = { x: 0, y: 0, width: 10, height: 5 };
    const quad = rectToQuad(box);
    expect(quad[0]).toEqual({ x: 0, y: 0 });   // TL
    expect(quad[1]).toEqual({ x: 10, y: 0 });  // TR
    expect(quad[2]).toEqual({ x: 10, y: 5 });  // BR
    expect(quad[3]).toEqual({ x: 0, y: 5 });   // BL
  });

  it("converts an offset Rect correctly", () => {
    const box: Rect = { x: 3, y: 7, width: 4, height: 2 };
    const quad = rectToQuad(box);
    expect(quad[0]).toEqual({ x: 3, y: 7 });
    expect(quad[1]).toEqual({ x: 7, y: 7 });
    expect(quad[2]).toEqual({ x: 7, y: 9 });
    expect(quad[3]).toEqual({ x: 3, y: 9 });
  });
});

describe("inferDirection", () => {
  it("returns 'v' for tall boxes (height > width)", () => {
    const box: Rect = { x: 0, y: 0, width: 5, height: 20 };
    expect(inferDirection(box)).toBe("v");
  });

  it("returns 'h' for wide boxes (width >= height)", () => {
    const box: Rect = { x: 0, y: 0, width: 20, height: 5 };
    expect(inferDirection(box)).toBe("h");
  });

  it("returns 'h' for square boxes (width == height)", () => {
    const box: Rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(inferDirection(box)).toBe("h");
  });
});

describe("intersectsOrNear", () => {
  it("returns true for overlapping rects", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 5, y: 5, width: 10, height: 10 };
    expect(intersectsOrNear(a, b, 0)).toBe(true);
  });

  it("returns true when separated by less than gap", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 13, y: 0, width: 10, height: 10 };
    // gap between right edge of a (10) and left edge of b (13) is 3
    expect(intersectsOrNear(a, b, 5)).toBe(true);
  });

  it("returns false when separated by more than gap", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 20, y: 0, width: 10, height: 10 };
    // gap = 10
    expect(intersectsOrNear(a, b, 5)).toBe(false);
  });

  it("returns true for identical rects with gap=0", () => {
    const a: Rect = { x: 5, y: 5, width: 10, height: 10 };
    expect(intersectsOrNear(a, a, 0)).toBe(true);
  });

  it("returns true for vertically nearby rects", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 0, y: 12, width: 10, height: 10 };
    // vertical gap = 2
    expect(intersectsOrNear(a, b, 5)).toBe(true);
  });
});

describe("mergeRects", () => {
  it("merges two nearby rects into one", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 12, y: 0, width: 10, height: 10 },
    ];
    const merged = mergeRects(rects, 5);
    // gap of 2 < 5, so they merge
    expect(merged.length).toBe(1);
    expect(merged[0].x).toBe(0);
    expect(merged[0].y).toBe(0);
    expect(merged[0].width).toBe(22); // 10 + 2 + 10
    expect(merged[0].height).toBe(10);
  });

  it("keeps far rects separate", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 50, y: 0, width: 10, height: 10 },
    ];
    const merged = mergeRects(rects, 5);
    expect(merged.length).toBe(2);
  });

  it("merges overlapping rects", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 15, height: 10 },
      { x: 10, y: 0, width: 15, height: 10 },
    ];
    const merged = mergeRects(rects, 0);
    expect(merged.length).toBe(1);
    expect(merged[0].width).toBe(25);
  });

  it("returns copy of rects when no merges happen", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 100, y: 100, width: 5, height: 5 },
    ];
    const merged = mergeRects(rects, 0);
    expect(merged).toEqual(rects);
  });

  it("merges transitively: first merges with second, then result merges with third", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 11, y: 0, width: 10, height: 10 },
      { x: 22, y: 0, width: 10, height: 10 },
    ];
    const merged = mergeRects(rects, 5);
    // All within gap of 5: gap(0,11)=1, gap(11,22)=1, gap(merged,22) after first merge
    // After first two merge → x:0, w:21. Then third at x:22, gap=1 < 5, merge again
    expect(merged.length).toBe(1);
    expect(merged[0].width).toBe(32);
  });
});

describe("connectedComponents", () => {
  it("returns empty array for all-zero mask", () => {
    const mask = new Uint8Array(100);
    expect(connectedComponents(mask, 10, 10)).toEqual([]);
  });

  it("finds a single blob and returns one rect", () => {
    const width = 20;
    const height = 20;
    const mask = new Uint8Array(width * height);
    // Fill a 6x6 block at position (5,5) to (10,10) — meets min size (>=10 pixels, >=4 width/height)
    for (let y = 5; y <= 10; y++) {
      for (let x = 5; x <= 10; x++) {
        mask[y * width + x] = 1;
      }
    }
    const rects = connectedComponents(mask, width, height);
    expect(rects.length).toBe(1);
    expect(rects[0].x).toBe(5);
    expect(rects[0].y).toBe(5);
    expect(rects[0].width).toBe(6);  // 10 - 5 + 1
    expect(rects[0].height).toBe(6); // 10 - 5 + 1
  });

  it("finds two separate blobs and returns two rects", () => {
    const width = 40;
    const height = 20;
    const mask = new Uint8Array(width * height);
    // First blob: (2,2) to (7,7)
    for (let y = 2; y <= 7; y++) {
      for (let x = 2; x <= 7; x++) {
        mask[y * width + x] = 1;
      }
    }
    // Second blob: (20,2) to (25,7)
    for (let y = 2; y <= 7; y++) {
      for (let x = 20; x <= 25; x++) {
        mask[y * width + x] = 1;
      }
    }
    const rects = connectedComponents(mask, width, height);
    expect(rects.length).toBe(2);
  });

  it("filters out small blobs (less than 10 pixels)", () => {
    const width = 20;
    const height = 20;
    const mask = new Uint8Array(width * height);
    // Only 4 pixels — too small
    mask[5 * width + 5] = 1;
    mask[5 * width + 6] = 1;
    mask[6 * width + 5] = 1;
    mask[6 * width + 6] = 1;
    const rects = connectedComponents(mask, width, height);
    expect(rects.length).toBe(0);
  });
});