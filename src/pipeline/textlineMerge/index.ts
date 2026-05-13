/**
 * Textline merge module — groups individual OCR text lines into logical text blocks.
 *
 * Algorithm fully aligned with zyddnys/manga-image-translator textline_merge:
 * 1. Build a graph where nodes are text lines, edges connect mergeable pairs.
 * 2. Find connected components as initial region candidates.
 * 3. Recursively split over-connected regions using MST edge analysis.
 * 4. Post-process: majority-vote direction, sort lines, average colors, merge text.
 */

import type { TextRegion, TextDirection, QuadPoint, Rect } from "../../types";
import { minAreaRect } from "../typeset/geometry";
import type { InternalQuad, MergedGroup } from "./mergePredicates";
import { buildInternalQuad, mergeTextRegions } from "./mergePredicates";

// ---------------------------------------------------------------------------
// Build merged TextRegion from a group of InternalQuads
// ---------------------------------------------------------------------------

function buildMergedRegion(group: MergedGroup, allQuads: InternalQuad[]): TextRegion {
  const { quads: txtlns, fgColor, bgColor } = group;

  // Concatenate texts in reading order
  const sourceText = txtlns.map((q) => q.text).join("\n");

  // Direction: majority already computed
  let hCount = 0;
  let vCount = 0;
  for (const q of txtlns) {
    if (q.direction === "h") {
      hCount++;
    } else {
      vCount++;
    }
  }
  let majorityDir: TextDirection;
  if (hCount !== vCount) {
    majorityDir = hCount > vCount ? "h" : "v";
  } else {
    // Tie-break: use the direction of the quad with highest aspect ratio
    let maxAR = -Infinity;
    majorityDir = "h";
    for (const q of txtlns) {
      if (q.aspectRatio > maxAR) {
        maxAR = q.aspectRatio;
        majorityDir = q.direction;
      }
      if (1 / q.aspectRatio > maxAR) {
        maxAR = 1 / q.aspectRatio;
        majorityDir = q.direction;
      }
    }
  }

  // Compute weighted log-probability
  const totalArea = allQuads.reduce((s, q) => s + q.area, 0);
  let totalLogProbs = 0;
  for (const q of txtlns) {
    totalLogProbs += Math.log(Math.max(1e-10, q.prob)) * q.area;
  }
  const prob = totalArea > 0 ? Math.exp(totalLogProbs / totalArea) : 0;

  // Average fontSize from component textlines
  const fontSize = txtlns.reduce((s, q) => s + q.fontSize, 0) / txtlns.length;

  // Union bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of txtlns) {
    for (const p of q.pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const box: Rect = {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };

  // Use minAreaRect to preserve rotation angle from detected text lines
  const allPoints: InternalQuad["pts"][number][] = [];
  for (const q of txtlns) {
    allPoints.push(...q.pts);
  }

  let quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  const mar = minAreaRect(allPoints);
  if (mar) {
    quad = mar.box;
  } else {
    quad = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ];
  }

  return {
    id: crypto.randomUUID(),
    box,
    quad,
    direction: majorityDir,
    prob,
    fontSize,
    fgColor,
    bgColor,
    originalLineCount: txtlns.length,
    sourceText,
    translatedText: "",
  };
}

// ---------------------------------------------------------------------------
// Public API — aligned with dispatch()
// ---------------------------------------------------------------------------

/**
 * Merge individual OCR text lines into logical text blocks.
 *
 * Insert this stage between OCR and Translation in the pipeline.
 * Input: per-line TextRegion[] (from OCR).
 * Output: merged TextRegion[] (fewer items, concatenated sourceText).
 */
export function mergeTextLines(regions: TextRegion[], width: number, height: number): TextRegion[] {
  if (regions.length === 0) {
    return [];
  }

  // Convert TextRegion[] to InternalQuad[]
  const quads = regions.map((r, i) => buildInternalQuad(r, i));

  // Run merge
  const groups = mergeTextRegions(quads, width, height);

  // Build output TextRegion[]
  return groups.map((group) => buildMergedRegion(group, quads));
}