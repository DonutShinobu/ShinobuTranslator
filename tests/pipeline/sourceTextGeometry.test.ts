import { describe, expect, it } from "vitest";
import {
  countSourceGeometryGlyphs,
  estimateVerticalSourceFontSize,
} from "../../src/pipeline/sourceTextGeometry";

describe("sourceTextGeometry", () => {
  it("counts whitespace-free source code points", () => {
    expect(countSourceGeometryGlyphs("昨日\n𠮷野家")).toBe(5);
  });

  it("caps vertical column width by its per-glyph inline advance", () => {
    expect(estimateVerticalSourceFontSize(40, 200, 10, 24)).toBe(20);
  });

  it("keeps the cross size when the source line is loosely spaced", () => {
    expect(estimateVerticalSourceFontSize(34, 273, 7, 24)).toBe(34);
  });

  it("uses the fallback when no source glyph slots are available", () => {
    expect(estimateVerticalSourceFontSize(40, 200, 0, 24)).toBe(24);
  });
});
