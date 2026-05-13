import { describe, it, expect, vi } from "vitest";
import { decodeCtcGreedy, tokenToText } from "../../../src/pipeline/ocr/decodeCtc";
import { tokenToTextAutoregressive, avgLogProbToConfidence } from "../../../src/pipeline/ocr/decodeAutoregressive";

// Both source modules import onnxruntime-web/all at module level.
// Mock it so the modules can load without a browser environment.
vi.mock("onnxruntime-web/all", () => ({
  InferenceSession: {},
  Tensor: class Tensor {
    data: unknown;
    dims: number[];
    type: string;
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
}));

// decodeAutoregressive also imports from preprocess which imports onnxruntime-web/all indirectly
vi.mock("../../../src/pipeline/ocr/preprocess", () => ({
  buildBatchImageTensor: vi.fn(),
}));

describe("decodeCtcGreedy", () => {
  it("returns empty array for all-blank path (all class 0)", () => {
    const steps = 3;
    const classes = 5;
    const logits = new Float32Array(steps * classes);
    // Set class 0 (blank) to highest value at each step
    for (let t = 0; t < steps; t++) {
      logits[t * classes + 0] = 10; // blank wins
    }
    const result = decodeCtcGreedy(logits, steps, classes);
    expect(result).toEqual([]);
  });

  it("collapses repeated tokens", () => {
    const steps = 4;
    const classes = 5;
    const logits = new Float32Array(steps * classes);
    // Step 0: blank (0) highest → skip
    // Step 1: token 3 highest
    // Step 2: token 3 highest again → collapsed (same as prev)
    // Step 3: token 2 highest
    logits[0 * classes + 0] = 10; // blank
    logits[1 * classes + 3] = 10; // token 3
    logits[2 * classes + 3] = 10; // token 3 (repeat)
    logits[3 * classes + 2] = 10; // token 2
    const result = decodeCtcGreedy(logits, steps, classes);
    expect(result).toEqual([3, 2]);
  });

  it("skips blank tokens (class 0)", () => {
    const steps = 5;
    const classes = 4;
    const logits = new Float32Array(steps * classes);
    // Pattern: blank → 1 → blank → 2 → blank
    logits[0 * classes + 0] = 10;
    logits[1 * classes + 1] = 10;
    logits[2 * classes + 0] = 10;
    logits[3 * classes + 2] = 10;
    logits[4 * classes + 0] = 10;
    const result = decodeCtcGreedy(logits, steps, classes);
    expect(result).toEqual([1, 2]);
  });

  it("does not collapse if same token appears with blank between", () => {
    const steps = 3;
    const classes = 4;
    const logits = new Float32Array(steps * classes);
    // Pattern: 1 → blank → 1 → should NOT collapse because blank separates
    logits[0 * classes + 1] = 10;
    logits[1 * classes + 0] = 10;
    logits[2 * classes + 1] = 10;
    const result = decodeCtcGreedy(logits, steps, classes);
    expect(result).toEqual([1, 1]);
  });
});

describe("tokenToText", () => {
  it("maps token to charset character with offset (token - 1)", () => {
    const charset = ["A", "B", "C"];
    // token 1 → charset[0] = "A"
    expect(tokenToText(1, charset)).toBe("A");
    // token 2 → charset[1] = "B"
    expect(tokenToText(2, charset)).toBe("B");
  });

  it("returns empty string when charset is null", () => {
    expect(tokenToText(5, null)).toBe("");
  });

  it("returns empty string for out-of-range index", () => {
    const charset = ["A", "B"];
    // token 0 → idx -1 → out of range
    expect(tokenToText(0, charset)).toBe("");
    // token 3 → idx 2 → out of range (charset has 2 elements)
    expect(tokenToText(3, charset)).toBe("");
  });
});

describe("tokenToTextAutoregressive", () => {
  it("maps normal token to charset character", () => {
    const charset = ["<S>", "</S>", "<SP>", "A", "B", "C"];
    // token 3 → charset[3] = "A"
    expect(tokenToTextAutoregressive(3, charset)).toBe("A");
  });

  it("returns empty string for special token <S>", () => {
    const charset = ["<S>", "</S>", "<SP>", "A"];
    expect(tokenToTextAutoregressive(0, charset)).toBe("");
  });

  it("returns empty string for special token </S>", () => {
    const charset = ["<S>", "</S>", "<SP>", "A"];
    expect(tokenToTextAutoregressive(1, charset)).toBe("");
  });

  it("returns space for <SP> token", () => {
    const charset = ["<S>", "</S>", "<SP>", "A"];
    expect(tokenToTextAutoregressive(2, charset)).toBe(" ");
  });

  it("returns empty string when charset is null", () => {
    expect(tokenToTextAutoregressive(5, null)).toBe("");
  });

  it("returns empty string for out-of-range token", () => {
    const charset = ["<S>", "</S>", "A"];
    expect(tokenToTextAutoregressive(10, charset)).toBe("");
    expect(tokenToTextAutoregressive(-1, charset)).toBe("");
  });
});

describe("avgLogProbToConfidence", () => {
  it("returns 1.0 for probability array [1.0]", () => {
    expect(avgLogProbToConfidence([1.0])).toBeCloseTo(1.0, 5);
  });

  it("returns 0.5 for probability array [0.5, 0.5]", () => {
    // exp(mean(log([0.5, 0.5]))) = exp(log(0.5)) = 0.5
    expect(avgLogProbToConfidence([0.5, 0.5])).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for empty array", () => {
    expect(avgLogProbToConfidence([])).toBe(0);
  });

  it("clamps very small probabilities to minimum 1e-6", () => {
    // 0 probability should not produce -Infinity
    const result = avgLogProbToConfidence([0, 0.5]);
    expect(result).toBeGreaterThan(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("computes geometric mean of probabilities", () => {
    // exp(mean(log([0.8, 0.9]))) ≈ sqrt(0.8 * 0.9)
    const result = avgLogProbToConfidence([0.8, 0.9]);
    const expected = Math.sqrt(0.8 * 0.9);
    expect(result).toBeCloseTo(expected, 5);
  });
});