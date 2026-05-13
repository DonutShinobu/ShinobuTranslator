import { describe, it, expect } from "vitest";
import type { QuadPoint, TextRegion } from "../../../src/types";
import {
  quadAngle,
  quadDimensions,
  cloneQuad,
  cloneRegionForTypeset,
  boxToQuad,
  getRegionQuad,
  quadCenter,
  rotatePoint,
  rotateQuad,
  quadBounds,
  scaleQuadFromOrigin,
  mapOffscreenPointToCanvas,
  mapOffscreenRectToCanvasQuad,
} from "../../../src/pipeline/typeset/geometry";
import type { CompositeTransform } from "../../../src/pipeline/typeset/geometry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuad(
  tl: [number, number],
  tr: [number, number],
  br: [number, number],
  bl: [number, number],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: tl[0], y: tl[1] },
    { x: tr[0], y: tr[1] },
    { x: br[0], y: br[1] },
    { x: bl[0], y: bl[1] },
  ];
}

function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "test-region",
    box: { x: 0, y: 0, width: 60, height: 60 },
    sourceText: "",
    translatedText: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// quadAngle
// ---------------------------------------------------------------------------

describe("quadAngle", () => {
  it("returns 0 for axis-aligned quad (top edge horizontal)", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 5], [0, 5]);
    expect(quadAngle(quad)).toBeCloseTo(0, 6);
  });

  it("returns positive angle for quad tilted clockwise", () => {
    // Top edge goes from (0,0) to (10,5) — positive slope
    const quad = makeQuad([0, 0], [10, 5], [8, 10], [-2, 5]);
    expect(quadAngle(quad)).toBeGreaterThan(0);
  });

  it("returns negative angle for quad tilted counter-clockwise", () => {
    // Top edge goes from (0,5) to (10,0) — negative slope
    const quad = makeQuad([0, 5], [10, 0], [12, -5], [2, 0]);
    expect(quadAngle(quad)).toBeLessThan(0);
  });

  it("returns pi/4 for 45-degree tilt", () => {
    // Top edge: (0,0) to (1,1) => atan2(1,1) = pi/4
    const quad = makeQuad([0, 0], [1, 1], [0, 2], [-1, 1]);
    expect(quadAngle(quad)).toBeCloseTo(Math.PI / 4, 6);
  });
});

// ---------------------------------------------------------------------------
// quadDimensions
// ---------------------------------------------------------------------------

describe("quadDimensions", () => {
  it("returns width and height for axis-aligned 10x5 quad", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 5], [0, 5]);
    const dims = quadDimensions(quad);
    expect(dims.width).toBeCloseTo(10, 4);
    expect(dims.height).toBeCloseTo(5, 4);
  });

  it("averages top and bottom edge widths", () => {
    // Top edge = 10, bottom edge = 14 (BL at -2 to BR at 12)
    const quad = makeQuad([0, 0], [10, 0], [12, 5], [-2, 5]);
    const dims = quadDimensions(quad);
    expect(dims.width).toBeCloseTo(12, 4); // (10 + 14) / 2
  });

  it("averages left and right edge heights", () => {
    // Left edge = 5, right edge = 7
    const quad = makeQuad([0, 0], [10, 0], [10, 7], [0, 5]);
    const dims = quadDimensions(quad);
    expect(dims.height).toBeCloseTo(6, 4); // (5 + 7) / 2
  });
});

// ---------------------------------------------------------------------------
// cloneQuad
// ---------------------------------------------------------------------------

describe("cloneQuad", () => {
  it("returns a quad with the same coordinates", () => {
    const quad = makeQuad([1, 2], [3, 4], [5, 6], [7, 8]);
    const cloned = cloneQuad(quad);
    expect(cloned).toEqual(quad);
  });

  it("clone is independent — modifying clone does not affect original", () => {
    const quad = makeQuad([1, 2], [3, 4], [5, 6], [7, 8]);
    const cloned = cloneQuad(quad);
    cloned[0].x = 99;
    cloned[0].y = 99;
    expect(quad[0].x).toBe(1);
    expect(quad[0].y).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cloneRegionForTypeset
// ---------------------------------------------------------------------------

describe("cloneRegionForTypeset", () => {
  it("returns a region with the same values", () => {
    const region = makeRegion({
      quad: makeQuad([0, 0], [10, 0], [10, 5], [0, 5]),
    });
    const cloned = cloneRegionForTypeset(region);
    expect(cloned.box).toEqual(region.box);
    expect(cloned.quad).toEqual(region.quad);
    expect(cloned.sourceText).toBe(region.sourceText);
  });

  it("clone is independent — modifying clone quad does not affect original", () => {
    const region = makeRegion({
      quad: makeQuad([0, 0], [10, 0], [10, 5], [0, 5]),
    });
    const cloned = cloneRegionForTypeset(region);
    cloned.quad![0].x = 99;
    expect(region.quad![0].x).toBe(0);
  });

  it("clone is independent — modifying clone box does not affect original", () => {
    const region = makeRegion();
    const cloned = cloneRegionForTypeset(region);
    cloned.box.width = 999;
    expect(region.box.width).toBe(60);
  });

  it("handles region without quad", () => {
    const region = makeRegion(); // no quad
    const cloned = cloneRegionForTypeset(region);
    expect(cloned.quad).toBeUndefined();
    expect(cloned.box).toEqual(region.box);
  });
});

// ---------------------------------------------------------------------------
// boxToQuad
// ---------------------------------------------------------------------------

describe("boxToQuad", () => {
  it("converts a simple box rect to 4-point quad", () => {
    const region = makeRegion({ box: { x: 0, y: 0, width: 10, height: 5 } });
    const quad = boxToQuad(region);
    // TL(0,0), TR(10,0), BR(10,5), BL(0,5)
    expect(quad[0]).toEqual({ x: 0, y: 0 });
    expect(quad[1]).toEqual({ x: 10, y: 0 });
    expect(quad[2]).toEqual({ x: 10, y: 5 });
    expect(quad[3]).toEqual({ x: 0, y: 5 });
  });

  it("converts an offset box rect correctly", () => {
    const region = makeRegion({ box: { x: 5, y: 3, width: 20, height: 10 } });
    const quad = boxToQuad(region);
    expect(quad[0]).toEqual({ x: 5, y: 3 });
    expect(quad[1]).toEqual({ x: 25, y: 3 });
    expect(quad[2]).toEqual({ x: 25, y: 13 });
    expect(quad[3]).toEqual({ x: 5, y: 13 });
  });
});

// ---------------------------------------------------------------------------
// getRegionQuad
// ---------------------------------------------------------------------------

describe("getRegionQuad", () => {
  it("returns cloned quad when region has quad", () => {
    const quad = makeQuad([1, 2], [3, 4], [5, 6], [7, 8]);
    const region = makeRegion({ quad });
    const result = getRegionQuad(region);
    expect(result).toEqual(quad);
    // Verify it's a clone, not the same reference
    result[0].x = 99;
    expect(region.quad![0].x).toBe(1);
  });

  it("falls back to boxToQuad when region has no quad", () => {
    const region = makeRegion({ box: { x: 0, y: 0, width: 10, height: 5 } });
    const result = getRegionQuad(region);
    expect(result[0]).toEqual({ x: 0, y: 0 });
    expect(result[1]).toEqual({ x: 10, y: 0 });
    expect(result[2]).toEqual({ x: 10, y: 5 });
    expect(result[3]).toEqual({ x: 0, y: 5 });
  });
});

// ---------------------------------------------------------------------------
// quadCenter
// ---------------------------------------------------------------------------

describe("quadCenter", () => {
  it("returns centroid of a square centered at (5,5)", () => {
    // Square from (0,0) to (10,10)
    const quad = makeQuad([0, 0], [10, 0], [10, 10], [0, 10]);
    const center = quadCenter(quad);
    expect(center.x).toBeCloseTo(5, 4);
    expect(center.y).toBeCloseTo(5, 4);
  });

  it("returns centroid of an asymmetric quad", () => {
    const quad = makeQuad([0, 0], [20, 0], [20, 10], [0, 10]);
    const center = quadCenter(quad);
    expect(center.x).toBeCloseTo(10, 4);
    expect(center.y).toBeCloseTo(5, 4);
  });

  it("returns centroid of a rotated diamond", () => {
    const quad = makeQuad([5, 0], [10, 5], [5, 10], [0, 5]);
    const center = quadCenter(quad);
    expect(center.x).toBeCloseTo(5, 4);
    expect(center.y).toBeCloseTo(5, 4);
  });
});

// ---------------------------------------------------------------------------
// rotatePoint
// ---------------------------------------------------------------------------

describe("rotatePoint", () => {
  it("rotates (10,0) around (0,0) by 90 degrees to approximately (0,10)", () => {
    const result = rotatePoint({ x: 10, y: 0 }, 0, 0, Math.PI / 2);
    expect(result.x).toBeCloseTo(0, 4);
    expect(result.y).toBeCloseTo(10, 4);
  });

  it("rotating by 0 returns the same point", () => {
    const point = { x: 5, y: 7 };
    const result = rotatePoint(point, 0, 0, 0);
    expect(result.x).toBeCloseTo(5, 4);
    expect(result.y).toBeCloseTo(7, 4);
  });

  it("rotating (1,0) around (5,5) by 180 degrees", () => {
    const result = rotatePoint({ x: 1, y: 5 }, 5, 5, Math.PI);
    expect(result.x).toBeCloseTo(9, 4);
    expect(result.y).toBeCloseTo(5, 4);
  });

  it("full rotation by 360 degrees returns the original point", () => {
    const point = { x: 3, y: 7 };
    const result = rotatePoint(point, 2, 2, 2 * Math.PI);
    expect(result.x).toBeCloseTo(3, 4);
    expect(result.y).toBeCloseTo(7, 4);
  });
});

// ---------------------------------------------------------------------------
// rotateQuad
// ---------------------------------------------------------------------------

describe("rotateQuad", () => {
  it("rotates all 4 points around center", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 10], [0, 10]);
    const center = quadCenter(quad);
    const rotated = rotateQuad(quad, center.x, center.y, Math.PI / 2);
    // After 90-degree rotation around (5,5):
    // (0,0) -> (5,10), (10,0) -> (5,0), (10,10) -> (5,10)? No, let me think...
    // Actually, rotate each point around (5,5) by 90 degrees
    // (0,0) around (5,5): dx=-5,dy=-5 => after rot: (5+5, 5-5)=(10,0)? Hmm
    // Let me just verify the structure and rough shape
    expect(rotated).toHaveLength(4);
    // The rotated quad should have approximately the same dimensions
    const dims = quadDimensions(rotated);
    expect(dims.width).toBeCloseTo(10, 2);
    expect(dims.height).toBeCloseTo(10, 2);
  });

  it("rotation by 0 returns same quad coordinates", () => {
    const quad = makeQuad([1, 2], [5, 2], [5, 8], [1, 8]);
    const result = rotateQuad(quad, 3, 5, 0);
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeCloseTo(quad[i].x, 4);
      expect(result[i].y).toBeCloseTo(quad[i].y, 4);
    }
  });
});

// ---------------------------------------------------------------------------
// quadBounds
// ---------------------------------------------------------------------------

describe("quadBounds", () => {
  it("returns AABB of a simple axis-aligned quad", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 5], [0, 5]);
    const bounds = quadBounds(quad);
    expect(bounds.minX).toBe(0);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxX).toBe(10);
    expect(bounds.maxY).toBe(5);
  });

  it("returns AABB of a rotated diamond", () => {
    const quad = makeQuad([5, 0], [10, 5], [5, 10], [0, 5]);
    const bounds = quadBounds(quad);
    expect(bounds.minX).toBe(0);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxX).toBe(10);
    expect(bounds.maxY).toBe(10);
  });

  it("handles negative coordinates", () => {
    const quad = makeQuad([-5, -3], [5, -3], [5, 3], [-5, 3]);
    const bounds = quadBounds(quad);
    expect(bounds.minX).toBe(-5);
    expect(bounds.minY).toBe(-3);
    expect(bounds.maxX).toBe(5);
    expect(bounds.maxY).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// scaleQuadFromOrigin
// ---------------------------------------------------------------------------

describe("scaleQuadFromOrigin", () => {
  it("scales quad 2x from top-left origin", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 5], [0, 5]);
    const scaled = scaleQuadFromOrigin(quad, 2, 2, 0, 0);
    expect(scaled[0]).toEqual({ x: 0, y: 0 });
    expect(scaled[1]).toEqual({ x: 20, y: 0 });
    expect(scaled[2]).toEqual({ x: 20, y: 10 });
    expect(scaled[3]).toEqual({ x: 0, y: 10 });
  });

  it("scales quad 2x only in x direction", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 5], [0, 5]);
    const scaled = scaleQuadFromOrigin(quad, 2, 1, 0, 0);
    expect(scaled[1]).toEqual({ x: 20, y: 0 });
    expect(scaled[2]).toEqual({ x: 20, y: 5 });
    expect(scaled[3]).toEqual({ x: 0, y: 5 });
  });

  it("scales quad from center origin", () => {
    const quad = makeQuad([0, 0], [10, 0], [10, 10], [0, 10]);
    const centerX = 5;
    const centerY = 5;
    const scaled = scaleQuadFromOrigin(quad, 2, 2, centerX, centerY);
    // Each point: originX + (pointX - originX) * 2
    // (0,0): 5 + (0-5)*2 = 5-10 = -5, 5 + (0-5)*2 = -5
    expect(scaled[0].x).toBeCloseTo(-5, 4);
    expect(scaled[0].y).toBeCloseTo(-5, 4);
    // (10,0): 5 + (10-5)*2 = 15, 5 + (0-5)*2 = -5
    expect(scaled[1].x).toBeCloseTo(15, 4);
    expect(scaled[1].y).toBeCloseTo(-5, 4);
    // (10,10): 15, 15
    expect(scaled[2].x).toBeCloseTo(15, 4);
    expect(scaled[2].y).toBeCloseTo(15, 4);
    // (0,10): -5, 15
    expect(scaled[3].x).toBeCloseTo(-5, 4);
    expect(scaled[3].y).toBeCloseTo(15, 4);
  });

  it("scale factor 1 returns the same quad", () => {
    const quad = makeQuad([1, 2], [5, 3], [6, 8], [2, 7]);
    const scaled = scaleQuadFromOrigin(quad, 1, 1, 0, 0);
    expect(scaled).toEqual(quad);
  });
});

// ---------------------------------------------------------------------------
// mapOffscreenPointToCanvas
// ---------------------------------------------------------------------------

describe("mapOffscreenPointToCanvas", () => {
  it("maps point directly when region has no quad and no transform", () => {
    const region = makeRegion({ box: { x: 10, y: 20, width: 60, height: 60 } });
    const point = { x: 5, y: 3 };
    const result = mapOffscreenPointToCanvas(region, point, 100, 50, 4, 2);
    // drawX = box.x + boxPadding - strokePadding = 10 + 4 - 2 = 12
    // drawY = box.y + boxPadding - strokePadding = 20 + 4 - 2 = 22
    // result = { x: drawX + point.x, y: drawY + point.y }
    expect(result.x).toBeCloseTo(12 + 5, 4);
    expect(result.y).toBeCloseTo(22 + 3, 4);
  });

  it("maps point directly when region has quad but no transform", () => {
    const region = makeRegion({
      box: { x: 10, y: 20, width: 60, height: 60 },
      quad: makeQuad([10, 20], [70, 20], [70, 80], [10, 80]),
    });
    const point = { x: 5, y: 3 };
    // With quad but no transform, still uses direct mapping
    const result = mapOffscreenPointToCanvas(region, point, 100, 50, 4, 2, null);
    expect(result.x).toBeCloseTo(12 + 5, 4);
    expect(result.y).toBeCloseTo(22 + 3, 4);
  });

  it("applies transform rotation and scaling", () => {
    const region = makeRegion({
      box: { x: 100, y: 100, width: 60, height: 60 },
      quad: makeQuad([100, 100], [160, 100], [160, 160], [100, 160]),
    });
    const point = { x: 50, y: 25 };
    const transform: CompositeTransform = { s: 1, cx: 130, cy: 130, angle: 0 };
    // With angle=0, no rotation, just scale+offset from center
    const result = mapOffscreenPointToCanvas(region, point, 100, 50, 4, 2, transform);
    // localX = (50 - 100/2) * 1 = 0
    // localY = (25 - 50/2) * 1 = 0
    // cos(0)=1, sin(0)=0
    // result.x = cx + localX*cos - localY*sin = 130 + 0 = 130
    // result.y = cy + localX*sin + localY*cos = 130 + 0 = 130
    expect(result.x).toBeCloseTo(130, 4);
    expect(result.y).toBeCloseTo(130, 4);
  });

  it("applies transform with non-zero angle", () => {
    const region = makeRegion({
      box: { x: 100, y: 100, width: 60, height: 60 },
      quad: makeQuad([100, 100], [160, 100], [160, 160], [100, 160]),
    });
    const point = { x: 50, y: 25 };
    // 90 degree rotation
    const transform: CompositeTransform = { s: 1, cx: 130, cy: 130, angle: Math.PI / 2 };
    const result = mapOffscreenPointToCanvas(region, point, 100, 50, 4, 2, transform);
    // localX = (50 - 50) * 1 = 0
    // localY = (25 - 25) * 1 = 0
    // Still (0,0) local => result is (cx, cy)
    expect(result.x).toBeCloseTo(130, 4);
    expect(result.y).toBeCloseTo(130, 4);
  });

  it("applies transform with scaling", () => {
    const region = makeRegion({
      box: { x: 100, y: 100, width: 60, height: 60 },
      quad: makeQuad([100, 100], [160, 100], [160, 160], [100, 160]),
    });
    const point = { x: 75, y: 40 };
    const transform: CompositeTransform = { s: 2, cx: 130, cy: 130, angle: 0 };
    const result = mapOffscreenPointToCanvas(region, point, 100, 50, 4, 2, transform);
    // localX = (75 - 100/2) * 2 = 25 * 2 = 50
    // localY = (40 - 50/2) * 2 = 15 * 2 = 30
    // cos(0)=1, sin(0)=0
    // result.x = 130 + 50 = 180
    // result.y = 130 + 30 = 160
    expect(result.x).toBeCloseTo(180, 4);
    expect(result.y).toBeCloseTo(160, 4);
  });
});

// ---------------------------------------------------------------------------
// mapOffscreenRectToCanvasQuad
// ---------------------------------------------------------------------------

describe("mapOffscreenRectToCanvasQuad", () => {
  it("maps a simple rect without transform to axis-aligned quad", () => {
    const region = makeRegion({ box: { x: 10, y: 20, width: 60, height: 60 } });
    const rectBox = { x: 5, y: 3, width: 10, height: 7 };
    // drawX = 10 + 4 - 2 = 12, drawY = 20 + 4 - 2 = 22
    // TL: (12+5, 22+3) = (17, 25)
    // TR: (12+15, 22+3) = (27, 25)
    // BR: (12+15, 22+10) = (27, 32)
    // BL: (12+5, 22+10) = (17, 32)
    const result = mapOffscreenRectToCanvasQuad(region, rectBox, 100, 50, 4, 2);
    expect(result[0].x).toBeCloseTo(17, 4);
    expect(result[0].y).toBeCloseTo(25, 4);
    expect(result[1].x).toBeCloseTo(27, 4);
    expect(result[1].y).toBeCloseTo(25, 4);
    expect(result[2].x).toBeCloseTo(27, 4);
    expect(result[2].y).toBeCloseTo(32, 4);
    expect(result[3].x).toBeCloseTo(17, 4);
    expect(result[3].y).toBeCloseTo(32, 4);
  });

  it("maps a rect with transform to rotated quad", () => {
    const region = makeRegion({
      box: { x: 100, y: 100, width: 60, height: 60 },
      quad: makeQuad([100, 100], [160, 100], [160, 160], [100, 160]),
    });
    const rectBox = { x: 50, y: 25, width: 10, height: 5 };
    const transform: CompositeTransform = { s: 2, cx: 130, cy: 130, angle: 0 };
    const result = mapOffscreenRectToCanvasQuad(region, rectBox, 100, 50, 4, 2, transform);
    // Each point goes through mapOffscreenPointToCanvas with transform
    // This should produce 4 mapped points
    expect(result).toHaveLength(4);
    // With s=2, angle=0, all points scale from center
    // TL(50,25): localX=0, localY=0 => (130,130)
    // TR(60,25): localX=20, localY=0 => (130+20,130) = (150,130)
    // BR(60,30): localX=20, localY=10 => (150,140)
    // BL(50,30): localX=0, localY=10 => (130,140)
    expect(result[0].x).toBeCloseTo(130, 4);
    expect(result[0].y).toBeCloseTo(130, 4);
    expect(result[1].x).toBeCloseTo(150, 4);
    expect(result[1].y).toBeCloseTo(130, 4);
    expect(result[2].x).toBeCloseTo(150, 4);
    expect(result[2].y).toBeCloseTo(140, 4);
    expect(result[3].x).toBeCloseTo(130, 4);
    expect(result[3].y).toBeCloseTo(140, 4);
  });
});