import { describe, expect, it } from "vitest";
import {
  resolveUnicodeVerticalOrientation,
  segmentVerticalGraphemes,
  tokenizeVerticalText,
  verticalOrientationUnicodeVersion,
} from "../../../packages/image-pipeline/src/pipeline/typeset/verticalOrientation";

describe("resolveUnicodeVerticalOrientation", () => {
  it("uses the pinned Unicode 17 data", () => {
    expect(verticalOrientationUnicodeVersion).toBe("17.0.0");
    expect(resolveUnicodeVerticalOrientation("国")).toBe("U");
    expect(resolveUnicodeVerticalOrientation("~")).toBe("R");
    expect(resolveUnicodeVerticalOrientation("〜")).toBe("Tr");
    expect(resolveUnicodeVerticalOrientation("～")).toBe("Tr");
    expect(resolveUnicodeVerticalOrientation("ー")).toBe("Tr");
    expect(resolveUnicodeVerticalOrientation("—")).toBe("R");
  });
});

describe("segmentVerticalGraphemes", () => {
  it("keeps combining marks with their base character", () => {
    expect(segmentVerticalGraphemes("e\u0301")).toEqual(["e\u0301"]);
  });
});

describe("tokenizeVerticalText", () => {
  it("rotates wave marks and the Japanese prolonged sound mark without collapsing their identity", () => {
    const tokens = tokenizeVerticalText("~〜～ー");
    expect(tokens.map((token) => token.kind)).toEqual([
      "sideways-run",
      "sideways-run",
      "sideways-run",
      "sideways-run",
    ]);
    expect(tokens.map((token) => token.displayText)).toEqual(["~", "〜", "～", "ー"]);
    expect(tokens.map((token) => token.orientation)).toEqual([
      "sideways",
      "transformed-sideways",
      "transformed-sideways",
      "transformed-sideways",
    ]);
  });

  it("rotates every prolonged sound mark, including repeated terminal marks", () => {
    const tokens = tokenizeVerticalText("そうだねーー");
    expect(tokens.slice(-2)).toMatchObject([
      { kind: "sideways-run", sourceText: "ー", orientation: "transformed-sideways", rotationDeg: 90 },
      { kind: "sideways-run", sourceText: "ー", orientation: "transformed-sideways", rotationDeg: 90 },
    ]);
    expect(tokenizeVerticalText("んー").at(-1)).toMatchObject({
      kind: "sideways-run",
      sourceText: "ー",
      rotationDeg: 90,
    });
  });

  it("does not reinterpret OCR-like repeated lowercase Latin text", () => {
    const tokens = tokenizeVerticalText("_lll");
    expect(tokens[0]).toMatchObject({
      kind: "upright-glyph",
      sourceText: "_",
      displayText: "︳",
      orientation: "transformed-upright",
    });
    expect(tokens[1]).toMatchObject({
      kind: "sideways-run",
      sourceText: "lll",
      rotationDeg: 90,
      sourceGlyphCount: 3,
    });
  });

  it("keeps em dash and horizontal bar distinct and rotates both", () => {
    const tokens = tokenizeVerticalText("—―");
    expect(tokens).toMatchObject([
      { kind: "sideways-run", sourceText: "—", displayText: "—", rotationDeg: 90 },
      { kind: "sideways-run", sourceText: "―", displayText: "―", rotationDeg: 90 },
    ]);
  });

  it("keeps single Latin characters and short uppercase acronyms upright", () => {
    expect(tokenizeVerticalText("N")).toMatchObject([
      { kind: "upright-glyph", sourceText: "N" },
    ]);
    expect(tokenizeVerticalText("ABC").map((token) => token.kind)).toEqual([
      "upright-glyph",
      "upright-glyph",
      "upright-glyph",
    ]);
  });

  it("coalesces Latin words and long uppercase sequences into sideways runs", () => {
    expect(tokenizeVerticalText("AveMujica")).toMatchObject([
      { kind: "sideways-run", sourceText: "AveMujica", rotationDeg: 90, sourceGlyphCount: 9 },
    ]);
    expect(tokenizeVerticalText("ABCDE")).toMatchObject([
      { kind: "sideways-run", sourceText: "ABCDE", sourceGlyphCount: 5 },
    ]);
  });

  it("uses tate-chu-yoko for one or two digits and rotates longer numbers", () => {
    expect(tokenizeVerticalText("1")).toMatchObject([
      { kind: "tate-chu-yoko", policy: "short-digits", displayText: "1" },
    ]);
    expect(tokenizeVerticalText("１２")).toMatchObject([
      { kind: "tate-chu-yoko", policy: "short-digits", displayText: "12" },
    ]);
    expect(tokenizeVerticalText("2026")).toMatchObject([
      { kind: "sideways-run", sourceText: "2026", rotationDeg: 90 },
    ]);
  });

  it.each(["!?", "?!", "!!", "??"])(
    "combines terminal %s as terminal-punctuation tate-chu-yoko",
    (punctuation) => {
      const token = tokenizeVerticalText(`真的吗${punctuation}`).at(-1);
      expect(token).toMatchObject({
        kind: "tate-chu-yoko",
        policy: "terminal-punctuation",
        sourceText: punctuation,
        displayText: punctuation,
        sourceGlyphCount: 2,
      });
    },
  );

  it("supports fullwidth, mixed-width, and trailing closer terminal pairs", () => {
    expect(tokenizeVerticalText("真的！？").at(-1)).toMatchObject({
      kind: "tate-chu-yoko",
      sourceText: "！？",
      displayText: "!?",
    });
    const tokens = tokenizeVerticalText("真的?！」");
    expect(tokens.at(-2)).toMatchObject({
      kind: "tate-chu-yoko",
      sourceText: "?！",
      displayText: "?!",
    });
    expect(tokens.at(-1)).toMatchObject({ sourceText: "」" });
    expect(tokenizeVerticalText("真的??  ").at(-1)).toMatchObject({
      kind: "tate-chu-yoko",
      sourceText: "??",
    });
  });

  it("does not combine non-terminal, single, or three-character punctuation runs", () => {
    expect(tokenizeVerticalText("真!?的吗").some((token) => token.kind === "tate-chu-yoko")).toBe(false);
    expect(tokenizeVerticalText("真的!").some((token) => token.kind === "tate-chu-yoko")).toBe(false);
    expect(tokenizeVerticalText("真的!!!").some((token) => token.kind === "tate-chu-yoko")).toBe(false);
    expect(tokenizeVerticalText("真的!?!").some((token) => token.kind === "tate-chu-yoko")).toBe(false);
  });
});
