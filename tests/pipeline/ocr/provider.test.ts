import { describe, it, expect } from "vitest";
import type { OcrRecognizeResult } from "../../../packages/image-pipeline/src/pipeline/ocr/provider";
import {
  inferDirectionFromQuad,
  fillMissingOcrFields,
} from "../../../packages/image-pipeline/src/pipeline/ocr/provider";
import type { QuadPoint } from "../../../packages/image-pipeline/src/types";

/** Helper: build a quad representing a horizontal rectangle (width >= height). */
function hQuad(): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 30 },
    { x: 0, y: 30 },
  ];
}

/** Helper: build a quad representing a vertical rectangle (height > width). */
function vQuad(): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 100 },
    { x: 0, y: 100 },
  ];
}

describe("inferDirectionFromQuad", () => {
  it("returns 'h' for horizontal quad (width >= height)", () => {
    expect(inferDirectionFromQuad(hQuad())).toBe("h");
  });

  it("returns 'v' for vertical quad (height > width)", () => {
    expect(inferDirectionFromQuad(vQuad())).toBe("v");
  });
});

describe("fillMissingOcrFields", () => {
  it("fills missing direction with 'h' for horizontal quad", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: hQuad(),
        // direction intentionally omitted
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].direction).toBe("h");
  });

  it("fills missing direction with 'v' for vertical quad", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: vQuad(),
        // direction intentionally omitted
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].direction).toBe("v");
  });

  it("preserves engine-provided direction (does not overwrite)", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: hQuad(), // horizontal quad, but engine says vertical
        direction: "v",
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].direction).toBe("v"); // engine value preserved
  });

  it("fills missing fgColor with default [0, 0, 0]", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: hQuad(),
        // fgColor intentionally omitted
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].fgColor).toEqual([0, 0, 0]);
  });

  it("fills missing bgColor with default [255, 255, 255]", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: hQuad(),
        // bgColor intentionally omitted
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].bgColor).toEqual([255, 255, 255]);
  });

  it("preserves engine-provided colors (does not overwrite)", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: hQuad(),
        fgColor: [128, 64, 32],
        bgColor: [200, 200, 200],
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].fgColor).toEqual([128, 64, 32]);
    expect(filled[0].bgColor).toEqual([200, 200, 200]);
  });

  it("fills all missing fields so every result has direction, fgColor, bgColor", () => {
    const results: OcrRecognizeResult[] = [
      {
        text: "hello",
        confidence: 0.9,
        quad: vQuad(),
        // direction, fgColor, bgColor all omitted
      },
      {
        text: "world",
        confidence: 0.8,
        quad: hQuad(),
        direction: "h",
        fgColor: [1, 2, 3],
        // bgColor omitted
      },
    ];
    const filled = fillMissingOcrFields(results);
    expect(filled[0].direction).toBe("v");
    expect(filled[0].fgColor).toEqual([0, 0, 0]);
    expect(filled[0].bgColor).toEqual([255, 255, 255]);
    expect(filled[1].direction).toBe("h"); // preserved
    expect(filled[1].fgColor).toEqual([1, 2, 3]); // preserved
    expect(filled[1].bgColor).toEqual([255, 255, 255]); // filled
  });
});