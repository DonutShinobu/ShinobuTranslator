import { describe, expect, it } from "vitest";
import type { TextRegion } from "../../../packages/image-pipeline/src/types";
import { mergeTextLines } from "../../../packages/image-pipeline/src/pipeline/textlineMerge";

function region(id: string, x: number, probability: number): TextRegion {
  return {
    id,
    box: { x, y: 20, width: 40, height: 20 },
    quad: [
      { x, y: 20 },
      { x: x + 40, y: 20 },
      { x: x + 40, y: 40 },
      { x, y: 40 },
    ],
    direction: "h",
    prob: probability,
    fgColor: [0, 0, 0],
    bgColor: [255, 255, 255],
    sourceText: id,
    translatedText: "",
  };
}

describe("mergeTextLines probability", () => {
  it("normalizes each merged group by the area inside that group", () => {
    const merged = mergeTextLines(
      [
        region("left", 20, 0.25),
        region("right", 400, 0.25),
      ],
      800,
      600,
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.prob)).toEqual([
      expect.closeTo(0.25, 10),
      expect.closeTo(0.25, 10),
    ]);
  });
});
