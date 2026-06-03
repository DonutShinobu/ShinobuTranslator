import { describe, expect, it } from "vitest";
import {
  buildScreenshotElementCandidates,
  getNextScreenshotElementCandidateIndex,
  moveScreenshotRect,
  normalizeScreenshotRect,
  resizeScreenshotRect,
  toDocumentScreenshotRect,
  toScreenshotCropRect,
  toViewportScreenshotRect,
} from "../../../src/content/core/screenshot";

describe("normalizeScreenshotRect", () => {
  it("normalizes reverse drag direction and clamps to the viewport", () => {
    expect(normalizeScreenshotRect(120, 90, -10, 260, 100, 200)).toEqual({
      left: 0,
      top: 90,
      width: 100,
      height: 110,
    });
  });
});

describe("toDocumentScreenshotRect", () => {
  it("converts viewport coordinates to document coordinates", () => {
    expect(toDocumentScreenshotRect({ left: 10, top: 20, width: 30, height: 40 }, 100, 200)).toEqual({
      left: 110,
      top: 220,
      width: 30,
      height: 40,
    });
  });
});

describe("toViewportScreenshotRect", () => {
  it("clamps an element rect to the visible viewport", () => {
    expect(toViewportScreenshotRect(
      { left: -10, top: 20, width: 80, height: 120 },
      100,
      100,
    )).toEqual({
      left: 0,
      top: 20,
      width: 70,
      height: 80,
    });
  });
});

describe("buildScreenshotElementCandidates", () => {
  it("filters tiny rects, deduplicates equal bounds, and sorts from smaller to larger", () => {
    const candidates = buildScreenshotElementCandidates([
      { element: "large", rect: { left: 0, top: 0, width: 300, height: 200 } },
      { element: "tiny", rect: { left: 20, top: 20, width: 8, height: 50 } },
      { element: "small", rect: { left: 30, top: 40, width: 120, height: 80 } },
      { element: "small-wrapper", rect: { left: 30.4, top: 40.4, width: 120.2, height: 80.2 } },
      { element: "medium", rect: { left: 20, top: 30, width: 180, height: 120 } },
    ], { width: 400, height: 300 });

    expect(candidates.map((candidate) => candidate.element)).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });
});

describe("getNextScreenshotElementCandidateIndex", () => {
  it("moves toward larger candidates for upward wheel movement", () => {
    expect(getNextScreenshotElementCandidateIndex(0, 3, "larger")).toBe(1);
    expect(getNextScreenshotElementCandidateIndex(2, 3, "larger")).toBe(2);
  });

  it("moves toward smaller candidates for downward wheel movement", () => {
    expect(getNextScreenshotElementCandidateIndex(2, 3, "smaller")).toBe(1);
    expect(getNextScreenshotElementCandidateIndex(0, 3, "smaller")).toBe(0);
  });

  it("handles empty candidate lists", () => {
    expect(getNextScreenshotElementCandidateIndex(0, 0, "larger")).toBe(-1);
  });
});

describe("moveScreenshotRect", () => {
  it("moves a selection while clamping it inside the viewport", () => {
    expect(moveScreenshotRect(
      { left: 30, top: 20, width: 80, height: 50 },
      200,
      -40,
      { width: 180, height: 120 },
    )).toEqual({
      left: 100,
      top: 0,
      width: 80,
      height: 50,
    });
  });
});

describe("resizeScreenshotRect", () => {
  it("resizes from a corner and keeps the opposite corner stable", () => {
    expect(resizeScreenshotRect(
      { left: 40, top: 30, width: 120, height: 90 },
      "nw",
      -20,
      10,
      { width: 240, height: 180 },
      12,
    )).toEqual({
      left: 20,
      top: 40,
      width: 140,
      height: 80,
    });
  });

  it("respects minimum size and viewport bounds", () => {
    expect(resizeScreenshotRect(
      { left: 40, top: 30, width: 120, height: 90 },
      "se",
      -200,
      200,
      { width: 180, height: 140 },
      24,
    )).toEqual({
      left: 40,
      top: 30,
      width: 24,
      height: 110,
    });
  });
});

describe("toScreenshotCropRect", () => {
  it("scales CSS viewport pixels to screenshot pixels", () => {
    expect(toScreenshotCropRect(
      { left: 10, top: 20, width: 100, height: 80 },
      { width: 200, height: 100 },
      { width: 400, height: 300 },
    )).toEqual({
      sx: 20,
      sy: 60,
      sw: 200,
      sh: 240,
    });
  });

  it("clamps crop bounds to the captured screenshot", () => {
    expect(toScreenshotCropRect(
      { left: 190, top: 90, width: 30, height: 30 },
      { width: 200, height: 100 },
      { width: 400, height: 200 },
    )).toEqual({
      sx: 380,
      sy: 180,
      sw: 20,
      sh: 20,
    });
  });
});
