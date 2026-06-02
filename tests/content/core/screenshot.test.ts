import { describe, expect, it } from "vitest";
import {
  normalizeScreenshotRect,
  toDocumentScreenshotRect,
  toScreenshotCropRect,
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
