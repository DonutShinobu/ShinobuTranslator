import { describe, it, expect } from "vitest";
import {
  countTextLength,
  charLength,
  splitColumns,
  splitByTextLength,
  resolveSourceColumns,
  resolveTranslatedColumns,
  rebalanceVerticalColumns,
  resolveVerticalPreferredColumns,
} from "../../../src/pipeline/typeset/columns";
import type { TextRegion } from "../../../src/types";

function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "r0",
    box: { x: 0, y: 0, width: 100, height: 200 },
    sourceText: "こんにちは",
    translatedText: "Hello",
    direction: "v",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// countTextLength & charLength
// ---------------------------------------------------------------------------

describe("charLength", () => {
  it("returns 1 for regular kana", () => {
    expect(charLength("あ")).toBe(1);
    expect(charLength("い")).toBe(1);
  });

  it("returns 1 for CJK ideograph", () => {
    expect(charLength("日")).toBe(1);
  });

  it("returns 1 for Latin character", () => {
    expect(charLength("A")).toBe(1);
  });

  it("returns 0.5 for small kana (っ, ッ, ぁ, ぃ, ぅ, ぇ, ぉ)", () => {
    expect(charLength("っ")).toBe(0.5);
    expect(charLength("ッ")).toBe(0.5);
    expect(charLength("ぁ")).toBe(0.5);
    expect(charLength("ぃ")).toBe(0.5);
    expect(charLength("ぅ")).toBe(0.5);
    expect(charLength("ぇ")).toBe(0.5);
    expect(charLength("ぉ")).toBe(0.5);
  });
});

describe("countTextLength", () => {
  it("counts regular characters as 1 each", () => {
    expect(countTextLength("あい")).toBe(2);
  });

  it("counts small kana as 0.5", () => {
    expect(countTextLength("っあ")).toBe(1.5);
  });

  it("returns 0 for empty string", () => {
    expect(countTextLength("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(countTextLength("   ")).toBe(0);
  });

  it("counts mixed small and regular kana correctly", () => {
    // っ(0.5) + あ(1) + ぃ(0.5) + う(1) = 3
    expect(countTextLength("っあぃう")).toBe(3);
  });

  it("trims input before counting", () => {
    // "  あい  " trimmed -> "あい" = 2
    expect(countTextLength("  あい  ")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// splitColumns
// ---------------------------------------------------------------------------

describe("splitColumns", () => {
  it("splits text by single newline", () => {
    expect(splitColumns("a\nb")).toEqual(["a", "b"]);
  });

  it("collapses multiple consecutive newlines into one split", () => {
    expect(splitColumns("a\n\nb")).toEqual(["a", "b"]);
  });

  it("returns single-element array for text without newlines", () => {
    expect(splitColumns("abc")).toEqual(["abc"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitColumns("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(splitColumns("   \n  ")).toEqual([]);
  });

  it("trims each segment", () => {
    expect(splitColumns("  a  \n  b  ")).toEqual(["a", "b"]);
  });

  it("filters out empty segments after trim", () => {
    expect(splitColumns("a\n \nb")).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// splitByTextLength
// ---------------------------------------------------------------------------

describe("splitByTextLength", () => {
  it("keeps all text when length fits maxLength", () => {
    const result = splitByTextLength("あい", 3);
    expect(result.kept).toBe("あい");
    expect(result.overflow).toBe("");
  });

  it("splits at exact maxLength boundary", () => {
    // "あい" has length 2, maxLength 2 -> kept = "あい", overflow = ""
    const result = splitByTextLength("あい", 2);
    expect(result.kept).toBe("あい");
    expect(result.overflow).toBe("");
  });

  it("splits when text exceeds maxLength", () => {
    // "あいう" length 3, maxLength 2 -> kept "あい", overflow "う"
    const result = splitByTextLength("あいう", 2);
    expect(result.kept).toBe("あい");
    expect(result.overflow).toBe("う");
  });

  it("handles small kana in length calculation", () => {
    // "っあいう" length = 0.5+1+1+1 = 3.5, maxLength 2
    // "っ" (0.5) + "あ" (1) = 1.5 <= 2
    // "っあい" = 0.5+1+1 = 2.5 > 2, so split after "っあ" (1.5)
    const result = splitByTextLength("っあい", 2);
    expect(result.kept).toBe("っあ");
    expect(result.overflow).toBe("い");
  });

  it("returns empty overflow when text length equals maxLength exactly", () => {
    const result = splitByTextLength("ab", 2);
    expect(result.kept).toBe("ab");
    expect(result.overflow).toBe("");
  });

  it("returns all text in overflow when maxLength is 0 and text is non-empty", () => {
    const result = splitByTextLength("あ", 0);
    expect(result.kept).toBe("");
    expect(result.overflow).toBe("あ");
  });

  it("returns empty kept and overflow for empty text", () => {
    const result = splitByTextLength("", 5);
    expect(result.kept).toBe("");
    expect(result.overflow).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveSourceColumns
// ---------------------------------------------------------------------------

describe("resolveSourceColumns", () => {
  it("splits sourceText by newlines", () => {
    const region = makeRegion({ sourceText: "こんにちは\nさようなら" });
    expect(resolveSourceColumns(region)).toEqual(["こんにちは", "さようなら"]);
  });

  it("returns single-element array for sourceText without newlines", () => {
    const region = makeRegion({ sourceText: "こんにちは" });
    expect(resolveSourceColumns(region)).toEqual(["こんにちは"]);
  });

  it("falls back to trimmed sourceText when split yields empty", () => {
    // sourceText is whitespace + newlines, split yields empty after trim/filter
    const region = makeRegion({ sourceText: "  \n  \n  " });
    // After splitColumns, all segments are empty after trim -> filter removes them
    // Fallback: trimmed sourceText = "" -> returns []
    expect(resolveSourceColumns(region)).toEqual([]);
  });

  it("returns empty array for empty sourceText", () => {
    const region = makeRegion({ sourceText: "" });
    expect(resolveSourceColumns(region)).toEqual([]);
  });

  it("collapses multiple newlines in sourceText", () => {
    const region = makeRegion({ sourceText: "a\n\nb" });
    expect(resolveSourceColumns(region)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// resolveTranslatedColumns
// ---------------------------------------------------------------------------

describe("resolveTranslatedColumns", () => {
  it("uses region.translatedColumns when present and non-empty", () => {
    const region = makeRegion({ translatedColumns: ["Hello", "World"] });
    const result = resolveTranslatedColumns(region, "ignored");
    expect(result).toEqual([
      { text: "Hello", source: "model" },
      { text: "World", source: "model" },
    ]);
  });

  it("trims and filters translatedColumns entries", () => {
    const region = makeRegion({ translatedColumns: ["  Hello  ", "", "  World  "] });
    const result = resolveTranslatedColumns(region, "ignored");
    expect(result).toEqual([
      { text: "Hello", source: "model" },
      { text: "World", source: "model" },
    ]);
  });

  it("falls back to splitting translatedText when translatedColumns is empty", () => {
    const region = makeRegion({ translatedColumns: [] });
    const result = resolveTranslatedColumns(region, "Hello\nWorld");
    expect(result).toEqual([
      { text: "Hello", source: "model" },
      { text: "World", source: "model" },
    ]);
  });

  it("falls back to splitting translatedText when translatedColumns is undefined", () => {
    const region = makeRegion({});
    const result = resolveTranslatedColumns(region, "Hello\nWorld");
    expect(result).toEqual([
      { text: "Hello", source: "model" },
      { text: "World", source: "model" },
    ]);
  });

  it("falls back to single-column when translatedText has no newlines", () => {
    const region = makeRegion({});
    const result = resolveTranslatedColumns(region, "Hello");
    expect(result).toEqual([{ text: "Hello", source: "model" }]);
  });

  it("returns empty array when translatedColumns is empty and translatedText is empty", () => {
    const region = makeRegion({ translatedColumns: [] });
    const result = resolveTranslatedColumns(region, "");
    expect(result).toEqual([]);
  });

  it("returns single-element from trimmed translatedText when split yields empty", () => {
    // translatedText is whitespace, splitColumns yields []
    // fallback: trimmed translatedText is "" -> []
    const region = makeRegion({ translatedColumns: [] });
    const result = resolveTranslatedColumns(region, "  \n  ");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rebalanceVerticalColumns
// ---------------------------------------------------------------------------

describe("rebalanceVerticalColumns", () => {
  it("returns empty columns when translatedColumns is empty", () => {
    const result = rebalanceVerticalColumns(["あい", "うえ"], []);
    expect(result.columns).toEqual([]);
    expect(result.sourceColumnLengths).toEqual([2, 2]);
    expect(result.singleColumnMaxLength).toBe(2);
  });

  it("returns single-column when source and translated both have one column", () => {
    const result = rebalanceVerticalColumns(["こんにちは"], [
      { text: "Hello", source: "model" },
    ]);
    expect(result.columns).toEqual([{ text: "Hello", source: "model" }]);
    expect(result.sourceColumnLengths).toEqual([5]);
  });

  it("preserves translated columns that fit within source column lengths", () => {
    // Source: 2 columns of length 5 and 3
    // Translated: 2 short columns
    const result = rebalanceVerticalColumns(["こんにちは", "さよ"], [
      { text: "Hello", source: "model" },
      { text: "Bye", source: "model" },
    ]);
    expect(result.columns.length).toBe(2);
    expect(result.columns[0].text).toBe("Hello");
    expect(result.columns[1].text).toBe("Bye");
  });

  it("splits long translated text across columns matching source lengths", () => {
    // Source: 2 columns, lengths [3, 3]
    // Translated: 1 long column "あいうえおか" (length 6)
    // Baseline = max(3,3) = 3
    // First column gets splitByTextLength("あいうえおか", 3) -> kept "あいう" overflow "えおか"
    // Second column gets "えおか"
    const result = rebalanceVerticalColumns(["あいう", "えおか"], [
      { text: "あいうえおか", source: "model" },
    ]);
    expect(result.columns.length).toBe(2);
    expect(result.columns[0].text).toBe("あいう");
    expect(result.columns[1].text).toBe("えおか");
  });

  it("does not split on the last column — overflow stays in that column", () => {
    // Source: 1 column length 3
    // Translated: 1 long column "あいうえお" (length 5)
    // Since we're at the last column (targetColumns-1 = 0), no split
    const result = rebalanceVerticalColumns(["あいう"], [
      { text: "あいうえお", source: "model" },
    ]);
    expect(result.columns.length).toBe(1);
    expect(result.columns[0].text).toBe("あいうえお");
  });

  it("carries overflow across columns", () => {
    // Source: 3 columns, lengths [2, 2, 2]
    // Translated: 2 columns, "あいう" (3) and "えおか" (3)
    // Baseline = 2
    // Column 0: "あいう" exceeds 2, split -> kept "あい", overflow "う"
    // Column 1: "うえおか" (carry + col2) exceeds 2, split -> kept "うえ"(? wait)
    // Actually let me think more carefully:
    // carry = "う", translatedItem[1] = "えおか"
    // current = "うえおか" (length 4), exceeds baselineLength 2
    // splitByTextLength("うえおか", 2) -> kept "うえ"(2), overflow "おか"
    // Column 2: carry "おか", translatedItem[2] = undefined
    // current = "おか", length 2, <= sourceLength[2] = 2
    const result = rebalanceVerticalColumns(["あい", "うえ", "おか"], [
      { text: "あいう", source: "model" },
      { text: "えおか", source: "model" },
    ]);
    expect(result.columns.length).toBeGreaterThanOrEqual(2);
    // First column should have text from first split
    expect(result.columns[0].text).toBe("あい");
    // Carry text gets source: 'split'
    expect(result.columns.some((col) => col.source === "split")).toBe(true);
  });

  it("uses baseline length for columns beyond source column count", () => {
    // Source: 1 column length 5
    // Translated: 2 columns "Hello" and "World"
    // Baseline = 5
    // Both "Hello"(5) and "World"(5) fit within baseline
    const result = rebalanceVerticalColumns(["こんにちは"], [
      { text: "Hello", source: "model" },
      { text: "World", source: "model" },
    ]);
    expect(result.columns.length).toBe(2);
    expect(result.columns[0].text).toBe("Hello");
    expect(result.columns[1].text).toBe("World");
  });

  it("trims translated columns and filters empty ones", () => {
    const result = rebalanceVerticalColumns(["あ"], [
      { text: "  Hello  ", source: "model" },
      { text: "", source: "model" },
    ]);
    // Empty column filtered out after normalization
    expect(result.columns.length).toBe(1);
    expect(result.columns[0].text).toBe("Hello");
  });

  it("computes singleColumnMaxLength correctly", () => {
    const result = rebalanceVerticalColumns(["あい", "うえお"], [
      { text: "Hello", source: "model" },
    ]);
    expect(result.sourceColumnLengths).toEqual([2, 3]);
    expect(result.singleColumnMaxLength).toBe(3);
  });

  it("returns null singleColumnMaxLength when source is empty", () => {
    const result = rebalanceVerticalColumns([], [
      { text: "Hello", source: "model" },
    ]);
    expect(result.singleColumnMaxLength).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalPreferredColumns
// ---------------------------------------------------------------------------

describe("resolveVerticalPreferredColumns", () => {
  it("returns empty columns when translated text is empty", () => {
    const region = makeRegion({ sourceText: "こんにちは", translatedText: "" });
    const result = resolveVerticalPreferredColumns(region, "");
    expect(result.columns).toEqual([]);
    expect(result.sourceColumns).toEqual(["こんにちは"]);
  });

  it("uses translatedColumns from region when available (rebalanced to source lengths)", () => {
    // Source "あい\nうえ" -> lengths [2, 2], baseline = 2
    // "Hello" (5) and "World" (5) exceed baseline, so rebalancing splits them
    const region = makeRegion({
      sourceText: "あい\nうえ",
      translatedColumns: ["Hello", "World"],
    });
    const result = resolveVerticalPreferredColumns(region, "ignored");
    expect(result.columns.length).toBeGreaterThanOrEqual(2);
    expect(result.sourceColumns).toEqual(["あい", "うえ"]);
  });

  it("passes through short translated columns when source lengths accommodate them", () => {
    // Source lengths [5, 5] accommodate "Hi"(2) and "Bye"(3)
    const region = makeRegion({
      sourceText: "こんにちは\nさようなら",
      translatedColumns: ["Hi", "Bye"],
    });
    const result = resolveVerticalPreferredColumns(region, "ignored");
    expect(result.columns.length).toBe(2);
    expect(result.columns[0].text).toBe("Hi");
    expect(result.columns[1].text).toBe("Bye");
  });

  it("falls back to splitting translatedText when no translatedColumns (rebalanced)", () => {
    // Source "あい\nうえ" -> lengths [2, 2], baseline = 2
    // "Hello\nWorld" -> columns [5, 5], rebalanced
    const region = makeRegion({
      sourceText: "あい\nうえ",
    });
    const result = resolveVerticalPreferredColumns(region, "Hello\nWorld");
    expect(result.columns.length).toBeGreaterThanOrEqual(2);
    expect(result.sourceColumns).toEqual(["あい", "うえ"]);
  });

  it("computes sourceColumnLengths correctly", () => {
    const region = makeRegion({ sourceText: "あいう\nえお" });
    const result = resolveVerticalPreferredColumns(region, "Hello");
    expect(result.sourceColumns).toEqual(["あいう", "えお"]);
    // "あいう" length = 3, "えお" length = 2
    expect(result.sourceColumnLengths).toEqual([3, 2]);
    expect(result.singleColumnMaxLength).toBe(3);
  });

  it("rebalances long translated text into multiple columns", () => {
    const region = makeRegion({
      sourceText: "あい\nうえ",
      translatedColumns: ["HelloWorld"],
    });
    const result = resolveVerticalPreferredColumns(region, "HelloWorld");
    // Source columns: ["あい", "うえ"], lengths [2, 2], baseline 2
    // Single translated column "HelloWorld" length ~10, exceeds baseline
    // Should be split across columns
    expect(result.columns.length).toBeGreaterThanOrEqual(2);
  });
});