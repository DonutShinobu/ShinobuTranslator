import type { TypesetDebugRegionLog, TypesetDebugVerticalItem } from '@shinobu/image-pipeline/benchmark';
import { tokenizeVerticalText } from '@shinobu/image-pipeline/benchmark';

export type VerticalGlyphQualityMetrics = {
  glyphQualityCoverage: number;
  glyphOrientationAccuracy: number;
  runContinuityRate: number;
  verticalItemCenterAlignment: number;
  glyphQualityScore: number;
};

function itemSignature(item: Pick<
  TypesetDebugVerticalItem,
  "sourceText" | "displayText" | "kind" | "orientation" | "unicodeOrientation" | "policy" | "rotationDeg"
>): string {
  return [
    item.sourceText,
    item.displayText,
    item.kind,
    item.orientation,
    item.unicodeOrientation,
    item.policy ?? "",
    item.rotationDeg ?? 0,
  ].join("\u0000");
}

function expectedItems(region: TypesetDebugRegionLog): ReturnType<typeof tokenizeVerticalText> {
  const segments = region.preferredColumns.length > 0
    ? region.preferredColumns
    : [region.translatedTextUsed];
  return segments.flatMap(tokenizeVerticalText);
}

function quadBounds(quad: TypesetDebugRegionLog["columnCanvasQuads"][number]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: Math.min(...quad.map((point) => point.x)),
    minY: Math.min(...quad.map((point) => point.y)),
    maxX: Math.max(...quad.map((point) => point.x)),
    maxY: Math.max(...quad.map((point) => point.y)),
  };
}

export function computeVerticalGlyphQuality(
  region: TypesetDebugRegionLog,
): VerticalGlyphQualityMetrics {
  const expected = expectedItems(region);
  const actualColumns = region.columnVerticalItems;
  if (!actualColumns) {
    return {
      glyphQualityCoverage: 0,
      glyphOrientationAccuracy: 0,
      runContinuityRate: 0,
      verticalItemCenterAlignment: 0,
      glyphQualityScore: 0,
    };
  }

  const actual = actualColumns.flat();
  const pairCount = Math.max(expected.length, actual.length);
  let signatureMatches = 0;
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    if (itemSignature(expected[index]) === itemSignature(actual[index])) {
      signatureMatches += 1;
    }
  }
  const glyphOrientationAccuracy = pairCount > 0 ? signatureMatches / pairCount : 1;

  const expectedRuns = expected.filter((item) =>
    item.kind === "sideways-run" && item.sourceGlyphCount > 1,
  );
  const availableRuns = new Map<string, number>();
  for (const item of actual) {
    if (item.kind !== "sideways-run" || item.sourceGlyphCount <= 1) continue;
    const signature = itemSignature(item);
    availableRuns.set(signature, (availableRuns.get(signature) ?? 0) + 1);
  }
  let preservedRuns = 0;
  for (const item of expectedRuns) {
    const signature = itemSignature(item);
    const available = availableRuns.get(signature) ?? 0;
    if (available > 0) {
      preservedRuns += 1;
      availableRuns.set(signature, available - 1);
    }
  }
  const runContinuityRate = expectedRuns.length > 0 ? preservedRuns / expectedRuns.length : 1;

  let centeredItems = 0;
  let positionedItems = 0;
  for (let columnIndex = 0; columnIndex < actualColumns.length; columnIndex += 1) {
    const quad = region.columnCanvasQuads[columnIndex];
    if (!quad) continue;
    const bounds = quadBounds(quad);
    const tolerance = Math.max(1, region.fittedFontSize * 0.1);
    for (const item of actualColumns[columnIndex]) {
      positionedItems += 1;
      if (
        item.x >= bounds.minX - tolerance && item.x <= bounds.maxX + tolerance
        && item.y >= bounds.minY - tolerance && item.y <= bounds.maxY + tolerance
      ) {
        centeredItems += 1;
      }
    }
  }
  const verticalItemCenterAlignment = positionedItems > 0 ? centeredItems / positionedItems : 1;
  const glyphQualityCoverage = expected.length > 0 ? Math.min(1, actual.length / expected.length) : 1;
  const glyphQualityScore = (
    glyphOrientationAccuracy * 0.5
    + runContinuityRate * 0.3
    + verticalItemCenterAlignment * 0.2
  );

  return {
    glyphQualityCoverage,
    glyphOrientationAccuracy,
    runContinuityRate,
    verticalItemCenterAlignment,
    glyphQualityScore,
  };
}
