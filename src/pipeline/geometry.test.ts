import { describe, it, expect } from "vitest";
import { convexHull, sortMiniBoxPoints, minAreaRect } from "./geometry";
import type { QuadPoint } from "../types";

describe("convexHull", () => {
  it("returns empty array for empty input", () => {
    expect(convexHull([])).toEqual([]);
  });

  it("returns single point for single input", () => {
    expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });

  it("returns convex hull of a square with interior point", () => {
    const points = [
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 10, y: 10 }, { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior
    ];
    const hull = convexHull(points);
    expect(hull).toHaveLength(4);
    expect(hull.every((p) => !(p.x === 5 && p.y === 5))).toBe(true);
  });
});

describe("sortMiniBoxPoints", () => {
  it("sorts 4 points into TL, TR, BR, BL order", () => {
    const points: QuadPoint[] = [
      { x: 10, y: 0 }, { x: 0, y: 0 },
      { x: 0, y: 10 }, { x: 10, y: 10 },
    ];
    const sorted = sortMiniBoxPoints(points);
    expect(sorted[0]).toEqual({ x: 0, y: 0 });
    expect(sorted[1]).toEqual({ x: 10, y: 0 });
    expect(sorted[2]).toEqual({ x: 10, y: 10 });
    expect(sorted[3]).toEqual({ x: 0, y: 10 });
  });
});

describe("minAreaRect", () => {
  it("returns null for empty input", () => {
    expect(minAreaRect([])).toBeNull();
  });

  it("returns axis-aligned rect for axis-aligned points", () => {
    const points = [
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 10, y: 5 }, { x: 0, y: 5 },
    ];
    const result = minAreaRect(points);
    expect(result).not.toBeNull();
    expect(result!.shortSide).toBeCloseTo(5, 1);
  });

  it("returns rotated rect for tilted points", () => {
    const points = [
      { x: 5, y: 0 }, { x: 10, y: 5 },
      { x: 5, y: 10 }, { x: 0, y: 5 },
    ];
    const result = minAreaRect(points);
    expect(result).not.toBeNull();
    const box = result!.box;
    const angle = Math.atan2(box[1].y - box[0].y, box[1].x - box[0].x);
    expect(Math.abs(angle)).toBeGreaterThan(0.01);
  });
});
