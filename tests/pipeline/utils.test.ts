import { describe, it, expect } from "vitest";
import {
  clamp,
  polygonSignedArea,
  polygonArea,
  rectIou,
  nmsBoxes,
  normalizeTextDeep,
  normalizeTextLight,
  convexHull,
  convexHullArea,
  UnionFind,
} from "../../src/pipeline/utils";
import type { Rect } from "../../src/types";

describe("clamp", () => {
  it("returns value when in range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("returns min when below range", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("returns max when above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("handles min == max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe("polygonSignedArea", () => {
  it("returns positive area for counter-clockwise square", () => {
    // CCW square: (0,0) → (10,0) → (10,10) → (0,10)
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const area = polygonSignedArea(points);
    expect(area).toBeCloseTo(100, 5);
  });

  it("returns negative area for clockwise square", () => {
    // CW square: (0,0) → (0,10) → (10,10) → (10,0)
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ];
    const area = polygonSignedArea(points);
    expect(area).toBeCloseTo(-100, 5);
  });
});

describe("polygonArea", () => {
  it("returns positive area regardless of winding order", () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ];
    const cw = [
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 0 },
    ];
    expect(polygonArea(ccw)).toBeCloseTo(50, 5);
    expect(polygonArea(cw)).toBeCloseTo(50, 5);
  });

  it("returns 0 for less than 3 points", () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    expect(polygonArea([])).toBe(0);
  });
});

describe("rectIou", () => {
  it("returns 1.0 for identical rects", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectIou(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for non-overlapping rects", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 20, y: 20, width: 10, height: 10 };
    expect(rectIou(a, b)).toBe(0);
  });

  it("returns partial IoU for overlapping rects", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 5, y: 5, width: 10, height: 10 };
    // Intersection: 5x5 = 25
    // Union: 100 + 100 - 25 = 175
    // IoU: 25/175 ≈ 0.1429
    expect(rectIou(a, b)).toBeCloseTo(25 / 175, 5);
  });

  it("returns 0 for edge-touching rects (zero overlap)", () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    const b: Rect = { x: 10, y: 0, width: 10, height: 10 };
    expect(rectIou(a, b)).toBe(0);
  });
});

describe("nmsBoxes", () => {
  it("suppresses overlapping low-score boxes", () => {
    const items = [
      { box: { x: 0, y: 0, width: 20, height: 20 }, score: 0.9 },
      { box: { x: 2, y: 2, width: 20, height: 20 }, score: 0.5 },
    ];
    // IoU between these two is high (>0.5 with threshold 0.3)
    const kept = nmsBoxes(items, 0.3);
    expect(kept.length).toBe(1);
    expect(kept[0].score).toBe(0.9);
  });

  it("keeps all boxes when they do not overlap", () => {
    const items = [
      { box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.5 },
      { box: { x: 50, y: 50, width: 10, height: 10 }, score: 0.9 },
    ];
    const kept = nmsBoxes(items, 0.3);
    expect(kept.length).toBe(2);
  });

  it("preserves high-score boxes even when they overlap multiple low-score ones", () => {
    const items = [
      { box: { x: 0, y: 0, width: 20, height: 20 }, score: 0.95 },
      { box: { x: 1, y: 1, width: 20, height: 20 }, score: 0.6 },
      { box: { x: 2, y: 2, width: 20, height: 20 }, score: 0.4 },
    ];
    const kept = nmsBoxes(items, 0.3);
    expect(kept.length).toBe(1);
    expect(kept[0].score).toBe(0.95);
  });
});

describe("normalizeTextDeep", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeTextDeep("  a  b  ")).toBe("a b");
  });

  it("replaces newlines with spaces", () => {
    expect(normalizeTextDeep("a\nb\nc")).toBe("a b c");
  });

  it("replaces mixed newlines (CRLF)", () => {
    expect(normalizeTextDeep("a\r\nb")).toBe("a b");
  });

  it("returns empty string for all-whitespace input", () => {
    expect(normalizeTextDeep("   ")).toBe("");
  });
});

describe("normalizeTextLight", () => {
  it("trims whitespace without collapsing internal spaces", () => {
    expect(normalizeTextLight("  a  b  ")).toBe("a  b");
  });

  it("preserves internal newlines", () => {
    expect(normalizeTextLight("  a\nb  ")).toBe("a\nb");
  });

  it("returns empty string for all-whitespace input", () => {
    expect(normalizeTextLight("   ")).toBe("");
  });
});

describe("convexHull", () => {
  it("returns empty array for empty input", () => {
    expect(convexHull([])).toEqual([]);
  });

  it("returns single point for single input", () => {
    expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });

  it("returns 4 hull points for square with interior point", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(4);
    // Interior point should not be in hull
    expect(hull.every((p) => !(p.x === 5 && p.y === 5))).toBe(true);
  });

  it("returns 3 hull points for triangle", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(3);
  });

  it("returns 2 points for collinear points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(2);
  });
});

describe("convexHullArea", () => {
  it("returns 0 for less than 3 points", () => {
    expect(convexHullArea([])).toBe(0);
    expect(convexHullArea([{ x: 0, y: 0 }])).toBe(0);
    expect(convexHullArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });

  it("returns area matching square hull", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(convexHullArea(points)).toBeCloseTo(50, 5);
  });

  it("computes hull area of non-convex input (L-shape)", () => {
    // L-shape — convex hull is a pentagon, not the bounding rectangle
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    const area = convexHullArea(points);
    // Convex hull: (0,0),(10,0),(10,5),(5,10),(0,10) → pentagon area = 87.5
    expect(area).toBeCloseTo(87.5, 5);
  });
});

describe("UnionFind", () => {
  it("find returns own index for uninitialized set", () => {
    const uf = new UnionFind(5);
    for (let i = 0; i < 5; i++) {
      expect(uf.find(i)).toBe(i);
    }
  });

  it("union merges two sets", () => {
    const uf = new UnionFind(3);
    expect(uf.union(0, 1)).toBe(true);
    expect(uf.find(0)).toBe(uf.find(1));
  });

  it("union returns false for already-merged elements", () => {
    const uf = new UnionFind(3);
    uf.union(0, 1);
    expect(uf.union(0, 1)).toBe(false);
  });

  it("path compression works after multiple unions", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    uf.union(2, 3);
    uf.union(1, 3);
    // All four should share the same root
    const root = uf.find(0);
    expect(uf.find(1)).toBe(root);
    expect(uf.find(2)).toBe(root);
    expect(uf.find(3)).toBe(root);
    // Element 4 stays separate
    expect(uf.find(4)).toBe(4);
  });
});