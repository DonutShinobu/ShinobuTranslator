import { describe, expect, it } from "vitest";
import { getScreenshotResultOverlayOffset } from "../../../src/content/core/ui";

describe("getScreenshotResultOverlayOffset", () => {
  it("keeps right and bottom anchored controls moving with the resized image edge", () => {
    const anchor = {
      anchorX: "right" as const,
      anchorY: "bottom" as const,
      offsetX: -72,
      offsetY: 8,
    };

    expect(getScreenshotResultOverlayOffset(anchor, { width: 400, height: 300 })).toEqual({
      left: 328,
      top: 308,
    });
    expect(getScreenshotResultOverlayOffset(anchor, { width: 480, height: 360 })).toEqual({
      left: 408,
      top: 368,
    });
  });

  it("keeps left and top anchored controls stable while the image resizes", () => {
    const anchor = {
      anchorX: "left" as const,
      anchorY: "top" as const,
      offsetX: 12,
      offsetY: -42,
    };

    expect(getScreenshotResultOverlayOffset(anchor, { width: 400, height: 300 })).toEqual({
      left: 12,
      top: -42,
    });
    expect(getScreenshotResultOverlayOffset(anchor, { width: 480, height: 360 })).toEqual({
      left: 12,
      top: -42,
    });
  });
});
