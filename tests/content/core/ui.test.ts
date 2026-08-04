import { describe, expect, it } from "vitest";
import { getScreenshotResultOverlayPositionStyle } from "../../../apps/extension/src/content/core/ui";

describe("getScreenshotResultOverlayPositionStyle", () => {
  it("uses CSS right and 100% top for controls anchored to the image edge", () => {
    const anchor = {
      anchorX: "right" as const,
      anchorY: "bottom" as const,
      offsetX: 0,
      offsetY: 8,
    };

    expect(getScreenshotResultOverlayPositionStyle(anchor)).toEqual({
      left: "auto",
      right: "0px",
      top: "calc(100% + 8px)",
    });
  });

  it("uses fixed left and top offsets for controls anchored away from the resized edge", () => {
    const anchor = {
      anchorX: "left" as const,
      anchorY: "top" as const,
      offsetX: 12,
      offsetY: -42,
    };

    expect(getScreenshotResultOverlayPositionStyle(anchor)).toEqual({
      left: "12px",
      right: "auto",
      top: "-42px",
    });
  });
});
