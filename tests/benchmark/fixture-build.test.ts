import { describe, expect, it } from "vitest";
import { bakeResultRegionToFixtureRegion } from "../../benchmark/typeset/src/fixture-build";
import type { BakeResultRegion } from "../../src/pipeline/bake";

function makeBakeRegion(direction: "h" | "v"): BakeResultRegion {
  return {
    id: `region-${direction}`,
    direction,
    box: { x: 10, y: 20, width: 100, height: 20 },
    sourceText: "横排文字",
    detectedColumns: [{
      centerX: 60,
      topY: 20,
      bottomY: 40,
      width: 100,
      height: 20,
      text: "横排文字",
      charCount: 4,
      quad: direction === "h" ? [
        { x: 10, y: 18 },
        { x: 110, y: 22 },
        { x: 109, y: 42 },
        { x: 9, y: 38 },
      ] : undefined,
    }],
    typesetDebug: {
      fittedFontSize: 20,
      columnBoxes: [{ x: 10, y: 20, width: 100, height: 20 }],
    },
  };
}

describe("bakeResultRegionToFixtureRegion", () => {
  it("preserves horizontal direction and estimates font size on the inline axis", () => {
    const fixture = bakeResultRegionToFixtureRegion(makeBakeRegion("h"));

    expect(fixture.direction).toBe("h");
    expect(fixture.groundTruth.columns[0].quad).toEqual([
      { x: 10, y: 18 },
      { x: 110, y: 22 },
      { x: 109, y: 42 },
      { x: 9, y: 38 },
    ]);
    expect(fixture.groundTruth.columns[0].estimatedFontSize).toBe(20);
    expect(fixture.groundTruth.columns[0].charCenters).toEqual([
      { x: 22, y: 28.5 },
      { x: 47, y: 29.5 },
      { x: 72, y: 30.5 },
      { x: 97, y: 31.5 },
    ]);
    expect(fixture.currentTypeset.columns[0].estimatedFontSize).toBe(20);
    expect(fixture.currentTypeset.columns[0].charCenters).toEqual([
      { x: 22.5, y: 30 },
      { x: 47.5, y: 30 },
      { x: 72.5, y: 30 },
      { x: 97.5, y: 30 },
    ]);
  });

  it("keeps vertical font estimation behavior", () => {
    const fixture = bakeResultRegionToFixtureRegion(makeBakeRegion("v"));

    expect(fixture.direction).toBe("v");
    expect(fixture.groundTruth.columns[0].estimatedFontSize).toBe(5);
  });

  it("uses grapheme clusters consistently for fixture character centers", () => {
    const region = makeBakeRegion("h");
    region.sourceText = "e\u0301字";
    region.detectedColumns![0].text = "e\u0301字";
    region.detectedColumns![0].charCount = 3;

    const fixture = bakeResultRegionToFixtureRegion(region);

    expect(fixture.groundTruth.columns[0].charCount).toBe(2);
    expect(fixture.groundTruth.columns[0].charCenters).toHaveLength(2);
  });
});
