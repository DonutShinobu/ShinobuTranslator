/**
 * Textline merge module — groups individual OCR text lines into logical text blocks.
 *
 * Algorithm fully aligned with zyddnys/manga-image-translator textline_merge:
 * 1. Build a graph where nodes are text lines, edges connect mergeable pairs.
 * 2. Find connected components as initial region candidates.
 * 3. Recursively split over-connected regions using MST edge analysis.
 * 4. Post-process: majority-vote direction, sort lines, average colors, merge text.
 */

import type { SourceTextLineGeometry, TextRegion, TextDirection, QuadPoint, Rect } from "../../types";
import { minAreaRect, type Quad } from "../typeset/geometry";
import type { InternalQuad, MergedGroup } from "./mergePredicates";
import { buildInternalQuad, mergeTextRegions } from "./mergePredicates";

type Axis = { x: number; y: number };

const axisEpsilon = 1e-6;

function normalizeAxis(axis: Axis): Axis | null {
  const norm = Math.hypot(axis.x, axis.y);
  if (!Number.isFinite(norm) || norm <= axisEpsilon) {
    return null;
  }
  return { x: axis.x / norm, y: axis.y / norm };
}

function axisDot(a: Axis, b: Axis): number {
  return a.x * b.x + a.y * b.y;
}

function resolveReferenceWidthAxis(quads: InternalQuad[], direction: TextDirection): Axis | null {
  const candidates = quads.flatMap((quad) => {
    if (quad.direction !== direction) {
      return [];
    }
    const axis = normalizeAxis({
      x: quad.pts[1].x - quad.pts[0].x,
      y: quad.pts[1].y - quad.pts[0].y,
    });
    if (!axis) {
      return [];
    }
    const weight = Number.isFinite(quad.area) && quad.area > 0 ? quad.area : 0;
    return [{ axis, weight }];
  });
  if (candidates.length === 0) {
    return null;
  }

  const anchor = candidates.reduce((best, candidate) => (
    candidate.weight > best.weight ? candidate : best
  ));
  let sumX = 0;
  let sumY = 0;
  let totalWeight = 0;
  for (const candidate of candidates) {
    const sign = axisDot(candidate.axis, anchor.axis) < 0 ? -1 : 1;
    const weight = candidate.weight > 0 ? candidate.weight : 1;
    sumX += candidate.axis.x * sign * weight;
    sumY += candidate.axis.y * sign * weight;
    totalWeight += weight;
  }
  if (totalWeight <= axisEpsilon) {
    return anchor.axis;
  }
  return normalizeAxis({ x: sumX / totalWeight, y: sumY / totalWeight }) ?? anchor.axis;
}

function rotateQuadStart(quad: Quad, offset: number): Quad {
  return [
    quad[offset % 4],
    quad[(offset + 1) % 4],
    quad[(offset + 2) % 4],
    quad[(offset + 3) % 4],
  ];
}

function alignQuadToReferenceWidthAxis(quad: Quad, referenceAxis: Axis | null): Quad {
  if (!referenceAxis) {
    return quad;
  }

  let best = quad;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < 4; offset += 1) {
    const candidate = rotateQuadStart(quad, offset);
    const widthAxis = normalizeAxis({
      x: candidate[1].x - candidate[0].x,
      y: candidate[1].y - candidate[0].y,
    });
    if (!widthAxis) {
      continue;
    }
    const score = axisDot(widthAxis, referenceAxis);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Build merged TextRegion from a group of InternalQuads
// ---------------------------------------------------------------------------

function internalQuadToSourceGeometry(q: InternalQuad): SourceTextLineGeometry {
  const xs = q.pts.map((p) => p.x);
  const ys = q.pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const topW = Math.hypot(q.pts[1].x - q.pts[0].x, q.pts[1].y - q.pts[0].y);
  const bottomW = Math.hypot(q.pts[2].x - q.pts[3].x, q.pts[2].y - q.pts[3].y);
  const leftH = Math.hypot(q.pts[3].x - q.pts[0].x, q.pts[3].y - q.pts[0].y);
  const rightH = Math.hypot(q.pts[2].x - q.pts[1].x, q.pts[2].y - q.pts[1].y);

  return {
    text: q.text,
    direction: q.direction,
    box: {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    },
    quad: q.pts.map((p) => ({ x: p.x, y: p.y })) as [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
    centerX: q.centroid.x,
    centerY: q.centroid.y,
    width: (topW + bottomW) / 2,
    height: (leftH + rightH) / 2,
    fontSize: q.fontSize,
  };
}

function buildMergedRegion(group: MergedGroup): TextRegion {
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
  const totalArea = txtlns.reduce((s, q) => s + q.area, 0);
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
    quad = alignQuadToReferenceWidthAxis(
      mar.box,
      resolveReferenceWidthAxis(txtlns, majorityDir),
    );
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
    sourceLineGeometries: txtlns.map(internalQuadToSourceGeometry),
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
  return groups.map((group) => buildMergedRegion(group));
}
