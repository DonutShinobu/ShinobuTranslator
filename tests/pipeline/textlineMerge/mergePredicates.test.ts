import { describe, it, expect } from "vitest";
import { mergeTextLines } from "../../../packages/image-pipeline/src/pipeline/textlineMerge";
import {
  buildInternalQuad,
  canMergeRegion,
  splitTextRegion,
  mergeTextRegions,
} from "../../../packages/image-pipeline/src/pipeline/textlineMerge/mergePredicates";
import type { TextRegion, TextDirection } from "../../../packages/image-pipeline/src/types";
import type { InternalQuad } from "../../../packages/image-pipeline/src/pipeline/textlineMerge/mergePredicates";
import { minAreaRect, quadAngle, quadDimensions } from "../../../packages/image-pipeline/src/pipeline/typeset/geometry";

// Helper to create a minimal TextRegion for testing
function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "r0",
    box: { x: 0, y: 0, width: 30, height: 60 },
    direction: "v",
    sourceText: "テスト",
    translatedText: "",
    ...overrides,
  };
}

function makeRotatedQuad(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  angleDeg: number,
): NonNullable<TextRegion["quad"]> {
  const angle = angleDeg * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotate = (x: number, y: number) => ({
    x: centerX + x * cos - y * sin,
    y: centerY + x * sin + y * cos,
  });
  return [
    rotate(-width / 2, -height / 2),
    rotate(width / 2, -height / 2),
    rotate(width / 2, height / 2),
    rotate(-width / 2, height / 2),
  ];
}

function boxForQuad(quad: NonNullable<TextRegion["quad"]>): TextRegion["box"] {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

// Helper to create an InternalQuad-like object for testing canMergeRegion.
// We need the full structure because canMergeRegion uses many fields.
function makeInternalQuad(overrides: Partial<InternalQuad> = {}): InternalQuad {
  const defaultQuad: InternalQuad = {
    pts: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 60 },
      { x: 0, y: 60 },
    ] as [InternalQuad["pts"][0], InternalQuad["pts"][1], InternalQuad["pts"][2], InternalQuad["pts"][3]],
    direction: "v" as TextDirection,
    text: "テスト",
    prob: 0.9,
    fgColor: [0, 0, 0] as [number, number, number],
    bgColor: [255, 255, 255] as [number, number, number],
    structure: [
      { x: 15, y: 0 },
      { x: 15, y: 60 },
      { x: 30, y: 30 },
      { x: 0, y: 30 },
    ] as [InternalQuad["structure"][0], InternalQuad["structure"][1], InternalQuad["structure"][2], InternalQuad["structure"][3]],
    fontSize: 30,
    aspectRatio: 1,
    angle: Math.PI / 2,
    cosAngle: 0,
    centroid: { x: 15, y: 30 },
    area: 1800,
    isApproximateAxisAligned: true,
    originalIndex: 0,
  };
  return { ...defaultQuad, ...overrides };
}

describe("buildInternalQuad", () => {
  it("constructs InternalQuad from a TextRegion with axis-aligned box", () => {
    const region = makeRegion();
    const iq = buildInternalQuad(region, 0);
    // The box is 30x60 (height > width), so direction should be "v"
    expect(iq.direction).toBe("v");
    expect(iq.text).toBe("テスト");
    expect(iq.originalIndex).toBe(0);
    expect(iq.area).toBeGreaterThan(0);
    // fontSize should be min(normV, normH)
    expect(iq.fontSize).toBeGreaterThan(0);
  });

  it("respects explicit direction override from region", () => {
    const region = makeRegion({ direction: "h" });
    const iq = buildInternalQuad(region, 1);
    // region.direction overrides inferred direction
    expect(iq.direction).toBe("h");
    expect(iq.originalIndex).toBe(1);
  });

  it("uses region quad points when provided", () => {
    const region = makeRegion({
      quad: [
        { x: 10, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
      ] as NonNullable<TextRegion["quad"]>,
    });
    const iq = buildInternalQuad(region, 0);
    // The quad is shifted from origin, centroid should reflect that
    expect(iq.centroid.x).toBeCloseTo(25, 1);
    expect(iq.centroid.y).toBeCloseTo(30, 1);
  });

  it("computes correct centroid for axis-aligned box", () => {
    const region = makeRegion({
      box: { x: 10, y: 20, width: 20, height: 40 },
    });
    const iq = buildInternalQuad(region, 0);
    expect(iq.centroid.x).toBeCloseTo(20, 1);
    expect(iq.centroid.y).toBeCloseTo(40, 1);
  });

  it("falls back to box-derived quad when region has no quad", () => {
    const region = makeRegion({ quad: undefined });
    const iq = buildInternalQuad(region, 0);
    expect(iq.pts).toBeDefined();
    expect(iq.pts.length).toBe(4);
  });
});

describe("canMergeRegion", () => {
  it("returns false for far apart quads", () => {
    const a = makeInternalQuad({
      pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 60 }, { x: 0, y: 60 }],
      centroid: { x: 15, y: 30 },
      fontSize: 30,
    });
    const b = makeInternalQuad({
      pts: [{ x: 200, y: 200 }, { x: 230, y: 200 }, { x: 230, y: 260 }, { x: 200, y: 260 }],
      centroid: { x: 215, y: 230 },
      fontSize: 30,
      originalIndex: 1,
    });
    expect(canMergeRegion(a, b)).toBe(false);
  });

  it("returns true for nearby aligned axis-aligned vertical quads", () => {
    // Two quads stacked vertically with small gap, same width
    const a = makeInternalQuad({
      pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 60 }, { x: 0, y: 60 }],
      centroid: { x: 15, y: 30 },
      fontSize: 30,
      aspectRatio: 1,
      isApproximateAxisAligned: true,
    });
    const b = makeInternalQuad({
      pts: [{ x: 0, y: 62 }, { x: 30, y: 62 }, { x: 30, y: 122 }, { x: 0, y: 122 }],
      centroid: { x: 15, y: 92 },
      fontSize: 30,
      aspectRatio: 1,
      isApproximateAxisAligned: true,
      originalIndex: 1,
      // Recompute structure for shifted quad
      structure: [
        { x: 15, y: 62 },
        { x: 15, y: 122 },
        { x: 30, y: 92 },
        { x: 0, y: 92 },
      ] as [InternalQuad["structure"][0], InternalQuad["structure"][1], InternalQuad["structure"][2], InternalQuad["structure"][3]],
    });
    // These are vertically aligned, close together, same fontSize
    expect(canMergeRegion(a, b, { discardConnectionGap: 2, charGapTolerance: 1 })).toBe(true);
  });

  it("returns false when fontSize ratio exceeds tolerance", () => {
    const a = makeInternalQuad({ fontSize: 10 });
    const b = makeInternalQuad({
      fontSize: 50,
      originalIndex: 1,
      // Move far enough to fail on poly distance too
      pts: [{ x: 200, y: 200 }, { x: 230, y: 200 }, { x: 230, y: 260 }, { x: 200, y: 260 }],
      centroid: { x: 215, y: 230 },
    });
    expect(canMergeRegion(a, b)).toBe(false);
  });
});

describe("splitTextRegion", () => {
  it("returns single group for single component", () => {
    const quads: InternalQuad[] = [
      makeInternalQuad({ originalIndex: 0 }),
    ];
    const result = splitTextRegion(quads, [0], 100, 100);
    expect(result).toEqual([[0]]);
  });

  it("returns two groups for two far-apart quads", () => {
    const quads: InternalQuad[] = [
      makeInternalQuad({
        originalIndex: 0,
        pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 60 }, { x: 0, y: 60 }],
        centroid: { x: 15, y: 30 },
        fontSize: 30,
      }),
      makeInternalQuad({
        originalIndex: 1,
        pts: [{ x: 200, y: 200 }, { x: 230, y: 200 }, { x: 230, y: 260 }, { x: 200, y: 260 }],
        centroid: { x: 215, y: 230 },
        fontSize: 30,
      }),
    ];
    const result = splitTextRegion(quads, [0, 1], 300, 300);
    expect(result.length).toBe(2);
  });

  it("splits two vertically stacked quads (expected: directional distance is large)", () => {
    // Two axis-aligned vertical quads stacked with a small pixel gap.
    // splitTextRegion's directional distance uses convex hull area ratio,
    // which is large even for small pixel gaps between vertical quads.
    const region1 = makeRegion({
      id: "r0",
      box: { x: 100, y: 10, width: 30, height: 60 },
      direction: "v",
      sourceText: "テ",
    });
    const region2 = makeRegion({
      id: "r1",
      box: { x: 100, y: 72, width: 30, height: 60 },
      direction: "v",
      sourceText: "スト",
    });
    const quads: InternalQuad[] = [
      buildInternalQuad(region1, 0),
      buildInternalQuad(region2, 1),
    ];
    // quadDirectionalDistance uses convex hull area / fontSize which is ~62 here
    // (1+gamma)*fontSize = 45, so 62 > 45 → they split
    const result = splitTextRegion(quads, [0, 1], 200, 200, 0.5, 2);
    expect(result.length).toBe(2);
  });
});

describe("mergeTextRegions", () => {
  it("returns empty array for empty input", () => {
    expect(mergeTextRegions([], 100, 100)).toEqual([]);
  });

  it("returns single group for single quad input", () => {
    const quads: InternalQuad[] = [makeInternalQuad()];
    const result = mergeTextRegions(quads, 100, 100);
    expect(result.length).toBe(1);
    expect(result[0].quads.length).toBe(1);
    expect(result[0].fgColor).toEqual([0, 0, 0]);
    expect(result[0].bgColor).toEqual([255, 255, 255]);
  });

  it("returns separate groups for far-apart quads", () => {
    const quads: InternalQuad[] = [
      makeInternalQuad({
        originalIndex: 0,
        pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 60 }, { x: 0, y: 60 }],
        centroid: { x: 15, y: 30 },
        fontSize: 30,
      }),
      makeInternalQuad({
        originalIndex: 1,
        pts: [{ x: 200, y: 200 }, { x: 230, y: 200 }, { x: 230, y: 260 }, { x: 200, y: 260 }],
        centroid: { x: 215, y: 230 },
        fontSize: 30,
      }),
    ];
    const result = mergeTextRegions(quads, 300, 300);
    // Too far apart to merge → two separate groups
    expect(result.length).toBe(2);
  });
});

describe("mergeTextLines sourceLineGeometries", () => {
  it("preserves vertical source column geometry in right-to-left order", () => {
    const regions: TextRegion[] = [
      makeRegion({
        id: "left-column",
        box: { x: 40, y: 10, width: 20, height: 100 },
        sourceText: "L",
        fontSize: 20,
      }),
      makeRegion({
        id: "right-column",
        box: { x: 65, y: 10, width: 20, height: 100 },
        sourceText: "R",
        fontSize: 20,
      }),
    ];

    const [merged] = mergeTextLines(regions, 200, 200);

    expect(merged.sourceText).toBe("R\nL");
    expect(merged.originalLineCount).toBe(2);
    expect(merged.sourceLineGeometries).toHaveLength(2);
    expect(merged.sourceLineGeometries?.[0]).toMatchObject({
      text: "R",
      direction: "v",
      centerX: 75,
      centerY: 60,
      width: 20,
      height: 100,
      fontSize: 20,
    });
    expect(merged.sourceLineGeometries?.[1]).toMatchObject({
      text: "L",
      direction: "v",
      centerX: 50,
      centerY: 60,
    });
  });
});

describe("mergeTextLines rotated quad ordering", () => {
  it("preserves the width axis of the rotated vertical SFX region", () => {
    const quad: NonNullable<TextRegion["quad"]> = [
      { x: 809, y: 184 },
      { x: 895, y: 117 },
      { x: 1087, y: 363 },
      { x: 1001, y: 430 },
    ];
    const [merged] = mergeTextLines([
      makeRegion({
        id: "rotated-sfx",
        box: { x: 809, y: 117, width: 278, height: 313 },
        quad,
        direction: "v",
        sourceText: "xx1 xx1",
      }),
    ], 1450, 2048);

    expect(merged.direction).toBe("v");
    expect(merged.quad).toBeDefined();
    const angleDeg = quadAngle(merged.quad!) * 180 / Math.PI;
    const dimensions = quadDimensions(merged.quad!);
    const expectedPointSet = minAreaRect(quad)?.box
      .map((point) => ({ x: point.x, y: point.y }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const actualPointSet = merged.quad!
      .map((point) => ({ x: point.x, y: point.y }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    expect(angleDeg).toBeCloseTo(-38, 0);
    expect(dimensions.width).toBeCloseTo(109, 0);
    expect(dimensions.height).toBeCloseTo(312, 0);
    expect(actualPointSet).toEqual(expectedPointSet);
  });

  it.each([
    ["axis-aligned horizontal", "h", 120, 30, 0],
    ["axis-aligned vertical", "v", 30, 120, 0],
    ["clockwise horizontal", "h", 120, 30, 25],
    ["counter-clockwise horizontal", "h", 120, 30, -25],
    ["clockwise vertical", "v", 30, 120, 25],
    ["counter-clockwise vertical", "v", 30, 120, -25],
  ] as const)("keeps %s geometry unchanged", (_name, direction, width, height, angleDeg) => {
    const quad = makeRotatedQuad(160, 160, width, height, angleDeg);
    const [merged] = mergeTextLines([
      makeRegion({
        box: boxForQuad(quad),
        quad,
        direction,
      }),
    ], 400, 400);

    expect(merged.direction).toBe(direction);
    expect(merged.quad).toBeDefined();
    expect(quadAngle(merged.quad!) * 180 / Math.PI).toBeCloseTo(angleDeg, 5);
    expect(quadDimensions(merged.quad!).width).toBeCloseTo(width, 5);
    expect(quadDimensions(merged.quad!).height).toBeCloseTo(height, 5);
  });

  it("uses the weighted source width axis for nearby rotated vertical lines", () => {
    const firstQuad = makeRotatedQuad(150, 160, 24, 110, -30);
    const secondQuad = makeRotatedQuad(173, 147, 20, 100, -26);
    const [merged] = mergeTextLines([
      makeRegion({
        id: "rotated-column-a",
        box: boxForQuad(firstQuad),
        quad: firstQuad,
        direction: "v",
        sourceText: "A",
      }),
      makeRegion({
        id: "rotated-column-b",
        box: boxForQuad(secondQuad),
        quad: secondQuad,
        direction: "v",
        sourceText: "B",
      }),
    ], 400, 400);

    expect(merged).toBeDefined();
    expect(merged.direction).toBe("v");
    expect(merged.originalLineCount).toBe(2);
    expect(merged.quad).toBeDefined();
    const angleDeg = quadAngle(merged.quad!) * 180 / Math.PI;
    const dimensions = quadDimensions(merged.quad!);
    expect(angleDeg).toBeLessThan(-20);
    expect(angleDeg).toBeGreaterThan(-35);
    expect(dimensions.height).toBeGreaterThan(dimensions.width);
  });
});
