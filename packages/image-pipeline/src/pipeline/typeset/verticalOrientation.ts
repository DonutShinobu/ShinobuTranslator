import { CJK_H2V } from "./columns";
import {
  verticalOrientationRanges,
  verticalOrientationUnicodeVersion,
} from "./verticalOrientationData";

export { verticalOrientationUnicodeVersion };

export type UnicodeVerticalOrientation = "U" | "R" | "Tu" | "Tr";
export type VerticalItemOrientation =
  | "upright"
  | "sideways"
  | "transformed-upright"
  | "transformed-sideways";
export type TateChuYokoPolicy = "short-digits" | "terminal-punctuation";

type VerticalTokenBase = {
  sourceText: string;
  displayText: string;
  sourceStart: number;
  sourceEnd: number;
  sourceGlyphCount: number;
  unicodeOrientation: UnicodeVerticalOrientation;
};

export type UprightVerticalToken = VerticalTokenBase & {
  kind: "upright-glyph";
  orientation: "upright" | "transformed-upright";
};

export type SidewaysVerticalToken = VerticalTokenBase & {
  kind: "sideways-run";
  orientation: "sideways" | "transformed-sideways";
  rotationDeg: 90;
};

export type TateChuYokoVerticalToken = VerticalTokenBase & {
  kind: "tate-chu-yoko";
  orientation: "upright";
  policy: TateChuYokoPolicy;
};

export type VerticalToken =
  | UprightVerticalToken
  | SidewaysVerticalToken
  | TateChuYokoVerticalToken;

const orientationByCode: readonly UnicodeVerticalOrientation[] = ["R", "U", "Tu", "Tr"];
const latinGraphemePattern = /^\p{Script=Latin}\p{M}*$/u;
const uppercaseLatinRunPattern = /^\p{Lu}+$/u;
const decimalDigitPattern = /^\p{Nd}$/u;
const terminalPunctuation = new Set(["!", "！", "?", "？"]);
const terminalClosers = new Set([
  ")", "]", "}", "）", "］", "｝",
  "」", "』", "】", "》", "〉", "〕", "〗", "〙", "〛",
  "'", "\"", "’", "”", "〞", "〟",
]);

let graphemeSegmenter: Intl.Segmenter | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (graphemeSegmenter) return graphemeSegmenter;
  if (typeof Intl.Segmenter !== "function") return undefined;
  graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter;
}

export function segmentVerticalGraphemes(text: string): string[] {
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (entry) => entry.segment);
}

export function resolveUnicodeVerticalOrientation(grapheme: string): UnicodeVerticalOrientation {
  const codePoint = grapheme.codePointAt(0);
  if (codePoint === undefined) return "R";

  let low = 0;
  let high = verticalOrientationRanges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end, valueCode] = verticalOrientationRanges[middle];
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else {
      return orientationByCode[valueCode] ?? "R";
    }
  }
  return "R";
}

function isLatinGrapheme(grapheme: string): boolean {
  return latinGraphemePattern.test(grapheme);
}

function isDecimalDigit(grapheme: string): boolean {
  return decimalDigitPattern.test(grapheme);
}

function isWhitespaceGrapheme(grapheme: string): boolean {
  return /^\s+$/u.test(grapheme);
}

function findTerminalContentEnd(graphemes: readonly string[]): number {
  let contentEnd = graphemes.length;
  while (contentEnd > 0 && isWhitespaceGrapheme(graphemes[contentEnd - 1])) {
    contentEnd -= 1;
  }
  while (contentEnd > 0 && terminalClosers.has(graphemes[contentEnd - 1])) {
    contentEnd -= 1;
  }
  return contentEnd;
}

function findTerminalDoublePunctuationStart(
  graphemes: readonly string[],
  contentEnd: number,
): number | undefined {
  let punctuationStart = contentEnd;
  while (punctuationStart > 0 && terminalPunctuation.has(graphemes[punctuationStart - 1])) {
    punctuationStart -= 1;
  }
  return contentEnd - punctuationStart === 2 ? punctuationStart : undefined;
}

function createUprightToken(
  sourceText: string,
  displayText: string,
  sourceStart: number,
  unicodeOrientation: UnicodeVerticalOrientation,
  transformed: boolean,
): UprightVerticalToken {
  return {
    kind: "upright-glyph",
    sourceText,
    displayText,
    sourceStart,
    sourceEnd: sourceStart + 1,
    sourceGlyphCount: 1,
    unicodeOrientation,
    orientation: transformed ? "transformed-upright" : "upright",
  };
}

function createSidewaysToken(
  sourceText: string,
  sourceStart: number,
  sourceGlyphCount: number,
  unicodeOrientation: UnicodeVerticalOrientation,
): SidewaysVerticalToken {
  return {
    kind: "sideways-run",
    sourceText,
    displayText: sourceText,
    sourceStart,
    sourceEnd: sourceStart + sourceGlyphCount,
    sourceGlyphCount,
    unicodeOrientation,
    orientation: unicodeOrientation === "Tr" ? "transformed-sideways" : "sideways",
    rotationDeg: 90,
  };
}

function createTateChuYokoToken(
  sourceText: string,
  sourceStart: number,
  sourceGlyphCount: number,
  policy: TateChuYokoPolicy,
): TateChuYokoVerticalToken {
  return {
    kind: "tate-chu-yoko",
    sourceText,
    displayText: sourceText.normalize("NFKC"),
    sourceStart,
    sourceEnd: sourceStart + sourceGlyphCount,
    sourceGlyphCount,
    unicodeOrientation: "U",
    orientation: "upright",
    policy,
  };
}

function createSingleGraphemeToken(grapheme: string, sourceStart: number): VerticalToken {
  const unicodeOrientation = resolveUnicodeVerticalOrientation(grapheme);
  const verticalForm = CJK_H2V.get(grapheme);
  if (verticalForm) {
    return createUprightToken(grapheme, verticalForm, sourceStart, unicodeOrientation, true);
  }
  if (unicodeOrientation === "U" || unicodeOrientation === "Tu") {
    return createUprightToken(grapheme, grapheme, sourceStart, unicodeOrientation, false);
  }
  return createSidewaysToken(grapheme, sourceStart, 1, unicodeOrientation);
}

export function tokenizeVerticalText(text: string): VerticalToken[] {
  const graphemes = segmentVerticalGraphemes(text);
  const terminalContentEnd = findTerminalContentEnd(graphemes);
  const terminalDoubleStart = findTerminalDoublePunctuationStart(graphemes, terminalContentEnd);
  const tokens: VerticalToken[] = [];

  for (let index = 0; index < graphemes.length;) {
    const grapheme = graphemes[index];
    if (isWhitespaceGrapheme(grapheme)) {
      index += 1;
      continue;
    }

    if (index === terminalDoubleStart) {
      const sourceText = graphemes.slice(index, index + 2).join("");
      tokens.push(createTateChuYokoToken(sourceText, index, 2, "terminal-punctuation"));
      index += 2;
      continue;
    }

    if (isDecimalDigit(grapheme)) {
      let end = index + 1;
      while (end < graphemes.length && isDecimalDigit(graphemes[end])) end += 1;
      const sourceText = graphemes.slice(index, end).join("");
      const glyphCount = end - index;
      tokens.push(glyphCount <= 2
        ? createTateChuYokoToken(sourceText, index, glyphCount, "short-digits")
        : createSidewaysToken(sourceText, index, glyphCount, "R"));
      index = end;
      continue;
    }

    if (isLatinGrapheme(grapheme)) {
      let end = index + 1;
      while (end < graphemes.length && isLatinGrapheme(graphemes[end])) end += 1;
      const sourceText = graphemes.slice(index, end).join("");
      const glyphCount = end - index;
      const keepUpright = glyphCount === 1
        || (glyphCount <= 4 && uppercaseLatinRunPattern.test(sourceText));
      if (keepUpright) {
        for (let sourceIndex = index; sourceIndex < end; sourceIndex += 1) {
          tokens.push(createUprightToken(
            graphemes[sourceIndex],
            graphemes[sourceIndex],
            sourceIndex,
            resolveUnicodeVerticalOrientation(graphemes[sourceIndex]),
            false,
          ));
        }
      } else {
        tokens.push(createSidewaysToken(sourceText, index, glyphCount, "R"));
      }
      index = end;
      continue;
    }

    tokens.push(createSingleGraphemeToken(grapheme, index));
    index += 1;
  }

  return tokens;
}
