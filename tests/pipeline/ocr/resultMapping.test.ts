import { describe, expect, it } from "vitest";
import type { TextRegion } from "../../../packages/image-pipeline/src/types";
import type { OcrRecognizeResult } from "../../../packages/image-pipeline/src/pipeline/ocr/provider";
import { mapResultsToRegions } from "../../../packages/image-pipeline/src/pipeline/ocr";

function region(id: string, x: number): TextRegion {
  return {
    id,
    box: { x, y: 10, width: 20, height: 30 },
    quad: [
      { x, y: 10 },
      { x: x + 20, y: 10 },
      { x: x + 20, y: 40 },
      { x, y: 40 },
    ],
    sourceText: "",
    translatedText: "",
  };
}

function result(regionId: string, text: string, confidence: number): OcrRecognizeResult {
  return {
    regionId,
    text,
    confidence,
    quad: [
      { x: 100, y: 10 },
      { x: 120, y: 10 },
      { x: 120, y: 40 },
      { x: 100, y: 40 },
    ],
  };
}

describe("mapResultsToRegions", () => {
  it("retains the source region when preceding OCR candidates were rejected", () => {
    const detected = [
      region("rejected-first", 10),
      region("accepted-second", 100),
    ];

    const mapped = mapResultsToRegions(
      [result("accepted-second", "あ", 0.9)],
      detected,
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      id: "accepted-second",
      box: detected[1].box,
      sourceText: "あ",
      prob: 0.9,
    });
  });
});
