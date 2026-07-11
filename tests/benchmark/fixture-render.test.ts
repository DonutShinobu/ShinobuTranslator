import { describe, expect, it } from "vitest";
import { groundTruthColumnToSourceGeometry } from "../../benchmark/typeset/src/fixture-render";

describe("groundTruthColumnToSourceGeometry", () => {
  it("preserves horizontal direction for horizontal focus fixtures", () => {
    expect(groundTruthColumnToSourceGeometry({
      index: 0,
      text: "横排",
      charCount: 2,
      centerX: 60,
      topY: 20,
      bottomY: 40,
      width: 80,
      height: 20,
      estimatedFontSize: 20,
      charCenters: [],
      quad: [
        { x: 22, y: 18 },
        { x: 102, y: 22 },
        { x: 98, y: 42 },
        { x: 18, y: 38 },
      ],
    }, "h")).toMatchObject({
      text: "横排",
      direction: "h",
      box: { x: 20, y: 20, width: 80, height: 20 },
      centerX: 60,
      centerY: 30,
      fontSize: 20,
      quad: [
        { x: 22, y: 18 },
        { x: 102, y: 22 },
        { x: 98, y: 42 },
        { x: 18, y: 38 },
      ],
    });
  });
});
