import type { BakeResultRegion, DetectedColumn } from "../../../src/pipeline/bake";
import { segmentVerticalGraphemes } from "../../../src/pipeline/typeset/verticalOrientation";
import type { TextDirection } from "../../../src/types";
import type { FixtureRegion, GroundTruthColumn } from "./types";

type Point = { x: number; y: number };

function nonWhitespaceGraphemes(text: string): string[] {
  return segmentVerticalGraphemes(text).filter((grapheme) => !/^\s+$/u.test(grapheme));
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function interpolatePoint(start: Point, end: Point, t: number): Point {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  };
}

function buildDetectedCharCenters(
  column: DetectedColumn,
  charCount: number,
  direction: TextDirection,
): Array<{ x?: number; y: number }> {
  if (charCount <= 0) return [];
  if (column.quad) {
    const [topLeft, topRight, bottomRight, bottomLeft] = column.quad;
    const start = direction === "h"
      ? midpoint(topLeft, bottomLeft)
      : midpoint(topLeft, topRight);
    const end = direction === "h"
      ? midpoint(topRight, bottomRight)
      : midpoint(bottomLeft, bottomRight);
    return Array.from({ length: charCount }, (_, index) => (
      interpolatePoint(start, end, (index + 0.5) / charCount)
    ));
  }

  if (direction === "h") {
    const step = column.width / charCount;
    return Array.from({ length: charCount }, (_, index) => ({
      x: column.centerX - column.width / 2 + step * (index + 0.5),
      y: (column.topY + column.bottomY) / 2,
    }));
  }
  const step = column.height / charCount;
  return Array.from({ length: charCount }, (_, index) => ({
    y: column.topY + step * index + step / 2,
  }));
}

function estimatedFontSize(
  width: number,
  height: number,
  charCount: number,
  direction: TextDirection,
  fallback: number,
): number {
  if (charCount <= 0) return Math.min(width, height, fallback);
  return direction === "h"
    ? Math.min(height, width / charCount)
    : Math.min(width, height / charCount);
}

export function buildGroundTruthColumns(
  detected: DetectedColumn[],
  direction: TextDirection,
): GroundTruthColumn[] {
  return detected.map((column, index) => {
    const chars = nonWhitespaceGraphemes(column.text);
    const charCenters = buildDetectedCharCenters(column, chars.length, direction);

    return {
      index,
      text: column.text,
      charCount: chars.length,
      centerX: column.centerX,
      topY: column.topY,
      bottomY: column.bottomY,
      width: column.width,
      height: column.height,
      estimatedFontSize: estimatedFontSize(
        column.width,
        column.height,
        chars.length,
        direction,
        24,
      ),
      charCenters,
      quad: column.quad,
    };
  });
}

export function buildTypesetSnapshotColumns(
  boxes: Array<{ x: number; y: number; width: number; height: number }>,
  sourceText: string,
  fontSize: number,
  direction: TextDirection,
): GroundTruthColumn[] {
  if (boxes.length === 0) return [];

  const chars = nonWhitespaceGraphemes(sourceText);
  const totalAdvance = boxes.reduce((sum, box) => (
    sum + (direction === "h" ? box.width : box.height)
  ), 0);
  let charIndex = 0;

  return boxes.map((box, index) => {
    const advance = direction === "h" ? box.width : box.height;
    const proportion = totalAdvance > 0 ? advance / totalAdvance : 1 / boxes.length;
    const boxCharCount = Math.max(1, Math.round(proportion * chars.length));
    const boxChars = chars.slice(charIndex, charIndex + boxCharCount);
    charIndex += boxChars.length;
    const charCenters = boxChars.map((_, sourceIndex) => {
      if (direction === "h") {
        const step = box.width / boxChars.length;
        return {
          x: box.x + step * (sourceIndex + 0.5),
          y: box.y + box.height / 2,
        };
      }
      const step = box.height / boxChars.length;
      return { y: box.y + step * sourceIndex + step / 2 };
    });

    return {
      index,
      text: boxChars.join(""),
      charCount: boxChars.length,
      centerX: box.x + box.width / 2,
      topY: box.y,
      bottomY: box.y + box.height,
      width: box.width,
      height: box.height,
      estimatedFontSize: estimatedFontSize(
        box.width,
        box.height,
        boxChars.length,
        direction,
        fontSize,
      ),
      charCenters,
    };
  });
}

export function bakeResultRegionToFixtureRegion(region: BakeResultRegion): FixtureRegion {
  return {
    id: region.id,
    direction: region.direction,
    box: region.box,
    quad: region.quad,
    sourceText: region.sourceText,
    fontSize: region.fontSize,
    fgColor: region.fgColor,
    bgColor: region.bgColor,
    originalLineCount: region.originalLineCount,
    translatedColumns: region.translatedColumns,
    groundTruth: {
      columns: buildGroundTruthColumns(region.detectedColumns ?? [], region.direction),
    },
    currentTypeset: {
      fittedFontSize: region.typesetDebug?.fittedFontSize ?? 0,
      columns: buildTypesetSnapshotColumns(
        region.typesetDebug?.columnBoxes ?? [],
        region.sourceText ?? "",
        region.typesetDebug?.fittedFontSize ?? 24,
        region.direction,
      ),
    },
  };
}
