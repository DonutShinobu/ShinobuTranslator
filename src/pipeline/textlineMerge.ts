/**
 * Textline merge module — groups individual OCR text lines into logical text blocks.
 *
 * Algorithm fully aligned with zyddnys/manga-image-translator textline_merge:
 * 1. Build a graph where nodes are text lines, edges connect mergeable pairs.
 * 2. Find connected components as initial region candidates.
 * 3. Recursively split over-connected regions using MST edge analysis.
 * 4. Post-process: majority-vote direction, sort lines, average colors, merge text.
 */

import type { TextRegion, TextDirection, QuadPoint, Rect } from "../types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type Point2D = { x: number; y: number };

type InternalQuad = {
  /** Sorted quad points: TL, TR, BR, BL */
  pts: [Point2D, Point2D, Point2D, Point2D];
  direction: TextDirection;
  text: string;
  prob: number;
  fgColor: [number, number, number];
  bgColor: [number, number, number];
  /** Four edge midpoints: top-mid, bottom-mid, right-mid, left-mid */
  structure: [Point2D, Point2D, Point2D, Point2D];
  /** min(||structure vec v||, ||structure vec h||) */
  fontSize: number;
  /** ||h_vec|| / ||v_vec|| */
  aspectRatio: number;
  /** angle of the vertical structure vector relative to x-axis */
  angle: number;
  cosAngle: number;
  centroid: Point2D;
  area: number;
  isApproximateAxisAligned: boolean;
  /** Original region index — bookkeeping only */
  originalIndex: number;
};

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

function vec2Norm(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

function vec2Sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vec2Dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Sort 4 quad points following the reference sort_pnts logic.
 * Returns [sorted_pts, is_vertical].
 *
 * The longer structure vector (mean of the two long-side vectors) determines
 * whether the quad is vertical or horizontal.
 */
function sortPoints(pts: Point2D[]): { sorted: [Point2D, Point2D, Point2D, Point2D]; isVertical: boolean } {
  if (pts.length !== 4) {
    throw new Error("sortPoints 需要正好 4 个点");
  }

  // Compute all 16 pairwise vectors and their norms
  const pairwiseNorms: number[] = [];
  const pairwiseVecs: Point2D[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const v = vec2Sub(pts[i], pts[j]);
      pairwiseVecs.push(v);
      pairwiseNorms.push(vec2Norm(v));
    }
  }

  // Find the two longest sides (indices 8 and 10 in argsort of norms)
  const indices = Array.from({ length: 16 }, (_, i) => i);
  indices.sort((a, b) => pairwiseNorms[a] - pairwiseNorms[b]);
  const longSideIds = [indices[8], indices[10]];

  const lv0 = pairwiseVecs[longSideIds[0]];
  let lv1 = pairwiseVecs[longSideIds[1]];

  // Make sure both long-side vectors point roughly the same direction
  if (vec2Dot(lv0, lv1) < 0) {
    lv1 = { x: -lv1.x, y: -lv1.y };
  }

  const strucVec = { x: Math.abs((lv0.x + lv1.x) / 2), y: Math.abs((lv0.y + lv1.y) / 2) };
  const isVertical = strucVec.x <= strucVec.y;

  // Copy points for sorting
  const p = pts.map((pt) => ({ x: pt.x, y: pt.y }));

  if (isVertical) {
    // Sort by y ascending
    p.sort((a, b) => a.y - b.y);
    // Top two: sort by x ascending
    const top = p.slice(0, 2).sort((a, b) => a.x - b.x);
    // Bottom two: sort by x descending
    const bot = p.slice(2, 4).sort((a, b) => b.x - a.x);
    return {
      sorted: [top[0], top[1], bot[0], bot[1]] as [Point2D, Point2D, Point2D, Point2D],
      isVertical: true,
    };
  } else {
    // Sort by x ascending
    p.sort((a, b) => a.x - b.x);
    const left = [p[0], p[1]].sort((a, b) => a.y - b.y);
    const right = [p[2], p[3]].sort((a, b) => a.y - b.y);
    return {
      sorted: [left[0], right[0], right[1], left[1]] as [Point2D, Point2D, Point2D, Point2D],
      isVertical: false,
    };
  }
}

/** Shoelace formula — signed area of a simple polygon (positive = CCW). */
function polygonSignedArea(pts: Point2D[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return area / 2;
}

function polygonArea(pts: Point2D[]): number {
  return Math.abs(polygonSignedArea(pts));
}

/** Andrew's monotone chain convex hull. Returns hull points in CCW order. */
function convexHull(points: Point2D[]): Point2D[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  pts.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

  if (pts.length <= 1) {
    return pts;
  }

  const cross = (o: Point2D, a: Point2D, b: Point2D): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  // Lower hull
  const lower: Point2D[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Upper hull
  const upper: Point2D[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half because it's repeated
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function convexHullArea(points: Point2D[]): number {
  if (points.length < 3) {
    return 0;
  }
  return polygonArea(convexHull(points));
}

/** Distance from point p to line segment (a, b). */
function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = abx * abx + aby * aby;
  if (denom <= 1e-10) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Minimum distance between two convex polygons (edge-vertex approach). */
function polygonMinDistance(polyA: Point2D[], polyB: Point2D[]): number {
  let best = Number.POSITIVE_INFINITY;
  const edgeDist = (poly1: Point2D[], poly2: Point2D[]): void => {
    const n = poly1.length;
    const m = poly2.length;
    for (let i = 0; i < n; i++) {
      const a = poly1[i];
      const b = poly1[(i + 1) % n];
      for (let j = 0; j < m; j++) {
        best = Math.min(best, pointToSegmentDist(poly2[j], a, b));
      }
    }
  };
  edgeDist(polyA, polyB);
  edgeDist(polyB, polyA);
  return best;
}

/** Euclidean distance between two points. */
function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

// ---------------------------------------------------------------------------
// InternalQuad construction — aligned with Quadrilateral class
// ---------------------------------------------------------------------------

function computeStructure(pts: [Point2D, Point2D, Point2D, Point2D]): [Point2D, Point2D, Point2D, Point2D] {
  const p1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; // top-mid
  const p2 = { x: (pts[2].x + pts[3].x) / 2, y: (pts[2].y + pts[3].y) / 2 }; // bottom-mid
  const p3 = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }; // right-mid
  const p4 = { x: (pts[3].x + pts[0].x) / 2, y: (pts[3].y + pts[0].y) / 2 }; // left-mid
  return [p1, p2, p3, p4];
}

function quadBbox(pts: [Point2D, Point2D, Point2D, Point2D]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

function buildInternalQuad(region: TextRegion, index: number): InternalQuad {
  // Get quad points from region
  const rawPts: Point2D[] = region.quad
    ? region.quad.map((p) => ({ x: p.x, y: p.y }))
    : [
        { x: region.box.x, y: region.box.y },
        { x: region.box.x + region.box.width, y: region.box.y },
        { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
        { x: region.box.x, y: region.box.y + region.box.height },
      ];

  const { sorted: pts, isVertical } = sortPoints(rawPts);
  const direction: TextDirection = isVertical ? "v" : "h";

  const structure = computeStructure(pts);
  const [p1, p2, p3, p4] = structure;

  // v1 = p2 - p1 (vertical structure vector)
  const v1 = vec2Sub(p2, p1);
  // v2 = p3 - p4 (horizontal structure vector)
  const v2 = vec2Sub(p3, p4);

  const normV = vec2Norm(v1);
  const normH = vec2Norm(v2);

  const fontSize = Math.min(normV, normH);
  const aspectRatio = normV > 1e-6 ? normH / normV : 1;

  // cosAngle: dot(v1 / ||v1||, [1, 0])
  const cosAngle = normV > 1e-6 ? v1.x / normV : 0;
  const angle = ((Math.acos(Math.max(-1, Math.min(1, cosAngle))) + Math.PI) % Math.PI);

  const centroid = {
    x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4,
    y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4,
  };

  // Polygon area via shoelace
  const area = polygonArea(pts);

  // isApproximateAxisAligned: check if v1 or v2 is nearly axis-aligned
  const e1: Point2D = { x: 0, y: 1 };
  const e2: Point2D = { x: 1, y: 0 };
  const uv1 = normV > 1e-6 ? { x: v1.x / normV, y: v1.y / normV } : { x: 0, y: 0 };
  const uv2 = normH > 1e-6 ? { x: v2.x / normH, y: v2.y / normH } : { x: 0, y: 0 };
  const isApproximateAxisAligned =
    Math.abs(vec2Dot(uv1, e1)) < 0.05 ||
    Math.abs(vec2Dot(uv1, e2)) < 0.05 ||
    Math.abs(vec2Dot(uv2, e1)) < 0.05 ||
    Math.abs(vec2Dot(uv2, e2)) < 0.05;

  return {
    pts,
    direction: region.direction ?? direction,
    text: region.sourceText,
    prob: region.prob ?? 1,
    fgColor: region.fgColor ?? [0, 0, 0],
    bgColor: region.bgColor ?? [255, 255, 255],
    structure,
    fontSize,
    aspectRatio,
    angle,
    cosAngle,
    centroid,
    area,
    isApproximateAxisAligned,
    originalIndex: index,
  };
}

// ---------------------------------------------------------------------------
// Polygon distance for InternalQuad — replaces Shapely Polygon().distance()
// ---------------------------------------------------------------------------

function quadPolyDistance(a: InternalQuad, b: InternalQuad): number {
  return polygonMinDistance(
    [a.pts[0], a.pts[1], a.pts[2], a.pts[3]],
    [b.pts[0], b.pts[1], b.pts[2], b.pts[3]]
  );
}

// ---------------------------------------------------------------------------
// Direction-aware distance — aligned with Quadrilateral.distance()
//
// NOTE: In the reference, assigned_direction is set during OCR region warping.
// In textline_merge, it may be unset (None), which causes the code to fall
// through to the 'v_top' branch. We replicate this: default to "v" when
// direction is uncertain.
// ---------------------------------------------------------------------------

function quadDirectionalDistance(a: InternalQuad, b: InternalQuad, rho: number = 0.5): number {
  const dir = a.direction; // may be "h" or "v"
  const fs = Math.max(a.fontSize, b.fontSize);

  if (dir === "h") {
    // Compute three candidate distances and pick the best alignment pattern
    const poly1Area = convexHullArea([a.pts[0], a.pts[3], b.pts[0], b.pts[3]]);
    const poly2Area = convexHullArea([a.pts[2], a.pts[1], b.pts[2], b.pts[1]]);
    const poly3Area = convexHullArea([a.structure[0], a.structure[1], b.structure[0], b.structure[1]]);
    const dist1 = poly1Area / Math.max(1, fs);
    const dist2 = poly2Area / Math.max(1, fs);
    const dist3 = poly3Area / Math.max(1, fs);

    let pattern = "h_left";
    if (dist1 < fs * rho) {
      pattern = "h_left";
    }
    if (dist2 < fs * rho && dist2 < dist1) {
      pattern = "h_right";
    }
    if (dist3 < fs * rho && dist3 < dist1 && dist3 < dist2) {
      pattern = "h_middle";
    }

    if (pattern === "h_left") {
      return dist(a.pts[0].x, a.pts[0].y, b.pts[0].x, b.pts[0].y);
    } else if (pattern === "h_right") {
      return dist(a.pts[1].x, a.pts[1].y, b.pts[1].x, b.pts[1].y);
    } else {
      return dist(a.structure[0].x, a.structure[0].y, b.structure[0].x, b.structure[0].y);
    }
  } else {
    // "v" or default
    const poly1Area = convexHullArea([a.pts[0], a.pts[1], b.pts[0], b.pts[1]]);
    const poly2Area = convexHullArea([a.pts[2], a.pts[3], b.pts[2], b.pts[3]]);
    const dist1 = poly1Area / Math.max(1, fs);
    const dist2 = poly2Area / Math.max(1, fs);

    let pattern = "v_top";
    if (dist1 < fs * rho) {
      pattern = "v_top";
    }
    if (dist2 < fs * rho && dist2 < dist1) {
      pattern = "v_bottom";
    }

    if (pattern === "v_top") {
      return dist(a.pts[0].x, a.pts[0].y, b.pts[0].x, b.pts[0].y);
    } else {
      return dist(a.pts[2].x, a.pts[2].y, b.pts[2].x, b.pts[2].y);
    }
  }
}

// ---------------------------------------------------------------------------
// Merge predicate — aligned with quadrilateral_can_merge_region()
// ---------------------------------------------------------------------------

function canMergeRegion(
  a: InternalQuad,
  b: InternalQuad,
  opts: {
    ratio?: number;
    discardConnectionGap?: number;
    charGapTolerance?: number;
    charGapTolerance2?: number;
    fontSizeRatioTol?: number;
    aspectRatioTol?: number;
  } = {}
): boolean {
  const {
    ratio = 1.9,
    discardConnectionGap = 2,
    charGapTolerance = 0.6,
    charGapTolerance2 = 1.5,
    fontSizeRatioTol = 1.5,
    aspectRatioTol = 2,
  } = opts;

  const charSize = Math.min(a.fontSize, b.fontSize);

  // Polygon distance (replaces Shapely Polygon.distance)
  const polyDist = quadPolyDistance(a, b);
  if (polyDist > discardConnectionGap * charSize) {
    return false;
  }

  if (Math.max(a.fontSize, b.fontSize) / Math.max(1e-6, charSize) > fontSizeRatioTol) {
    return false;
  }

  // Aspect ratio compatibility check
  if (a.aspectRatio > aspectRatioTol && b.aspectRatio < 1 / aspectRatioTol) {
    return false;
  }
  if (b.aspectRatio > aspectRatioTol && a.aspectRatio < 1 / aspectRatioTol) {
    return false;
  }

  const aAA = a.isApproximateAxisAligned;
  const bAA = b.isApproximateAxisAligned;

  if (aAA && bAA) {
    const bb1 = quadBbox(a.pts);
    const bb2 = quadBbox(b.pts);
    const { x: x1, y: y1, w: w1, h: h1 } = bb1;
    const { x: x2, y: y2, w: w2, h: h2 } = bb2;

    if (polyDist < charSize * charGapTolerance) {
      if (Math.abs(x1 + w1 / 2 - (x2 + w2 / 2)) < charGapTolerance2) {
        return true;
      }
      if (w1 > h1 * ratio && h2 > w2 * ratio) {
        return false;
      }
      if (w2 > h2 * ratio && h1 > w1 * ratio) {
        return false;
      }
      if (w1 > h1 * ratio || w2 > h2 * ratio) {
        // horizontal
        return (
          Math.abs(x1 - x2) < charSize * charGapTolerance2 ||
          Math.abs(x1 + w1 - (x2 + w2)) < charSize * charGapTolerance2
        );
      } else if (h1 > w1 * ratio || h2 > w2 * ratio) {
        // vertical
        return (
          Math.abs(y1 - y2) < charSize * charGapTolerance2 ||
          Math.abs(y1 + h1 - (y2 + h2)) < charSize * charGapTolerance2
        );
      }
      return false;
    } else {
      return false;
    }
  }

  // Non-axis-aligned (or mixed) — angle-based check
  if (Math.abs(a.angle - b.angle) < (15 * Math.PI) / 180) {
    const fs = Math.min(a.fontSize, b.fontSize);
    if (quadPolyDistance(a, b) > fs * charGapTolerance2) {
      return false;
    }
    if (Math.abs(a.fontSize - b.fontSize) / Math.max(1e-6, fs) > 0.25) {
      return false;
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Graph utilities — replaces NetworkX
// ---------------------------------------------------------------------------

class UnionFind {
  parent: number[];
  rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path compression
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) {
      return false;
    }
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
    return true;
  }
}

function findConnectedComponents(n: number, edges: [number, number][]): Set<number>[] {
  const uf = new UnionFind(n);
  for (const [u, v] of edges) {
    uf.union(u, v);
  }
  const groups = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, new Set());
    }
    groups.get(root)!.add(i);
  }
  return Array.from(groups.values());
}

type WeightedEdge = { u: number; v: number; weight: number };

/**
 * Kruskal MST on a subset of nodes. Returns edges sorted by weight ascending.
 */
function kruskalMST(nodeIndices: number[], weightFn: (u: number, v: number) => number): WeightedEdge[] {
  // Build all edges among node indices
  const edges: WeightedEdge[] = [];
  for (let i = 0; i < nodeIndices.length; i++) {
    for (let j = i + 1; j < nodeIndices.length; j++) {
      edges.push({ u: nodeIndices[i], v: nodeIndices[j], weight: weightFn(nodeIndices[i], nodeIndices[j]) });
    }
  }
  edges.sort((a, b) => a.weight - b.weight);

  // Map node indices to contiguous 0..n-1
  const indexMap = new Map<number, number>();
  nodeIndices.forEach((idx, i) => indexMap.set(idx, i));

  const uf = new UnionFind(nodeIndices.length);
  const mstEdges: WeightedEdge[] = [];

  for (const edge of edges) {
    const mu = indexMap.get(edge.u)!;
    const mv = indexMap.get(edge.v)!;
    if (uf.find(mu) !== uf.find(mv)) {
      uf.union(mu, mv);
      mstEdges.push(edge);
    }
  }

  return mstEdges;
}

// ---------------------------------------------------------------------------
// splitTextRegion — aligned with split_text_region()
// ---------------------------------------------------------------------------

function splitTextRegion(
  quads: InternalQuad[],
  regionIndices: number[],
  _width: number,
  _height: number,
  gamma: number = 0.5,
  sigma: number = 2
): number[][] {
  // Case 1: single element
  if (regionIndices.length === 1) {
    return [regionIndices];
  }

  // Case 2: two elements
  if (regionIndices.length === 2) {
    const idx0 = regionIndices[0];
    const idx1 = regionIndices[1];
    const fs = Math.max(quads[idx0].fontSize, quads[idx1].fontSize);
    const d = quadDirectionalDistance(quads[idx0], quads[idx1]);
    const angleDiff = Math.abs(quads[idx0].angle - quads[idx1].angle);
    if (d < (1 + gamma) * fs && angleDiff < 0.2 * Math.PI) {
      return [regionIndices];
    } else {
      return [[idx0], [idx1]];
    }
  }

  // Case 3: three or more — use MST
  const mstEdges = kruskalMST(regionIndices, (u, v) => quadDirectionalDistance(quads[u], quads[v]));

  // Sort MST edges by weight descending
  const edgesSorted = [...mstEdges].sort((a, b) => b.weight - a.weight);
  const distances = edgesSorted.map((e) => e.weight);

  const fontsize = regionIndices.reduce((sum, idx) => sum + quads[idx].fontSize, 0) / regionIndices.length;
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length;
  const std = Math.sqrt(distances.reduce((s, d) => s + (d - mean) * (d - mean), 0) / distances.length);
  const stdThreshold = Math.max(0.3 * fontsize + 5, 5);

  // Polygon distance and centroid alignment for the largest-distance edge pair
  const b1 = quads[edgesSorted[0].u];
  const b2 = quads[edgesSorted[0].v];
  const maxPolyDistance = quadPolyDistance(b1, b2);
  const maxCentroidAlignment = Math.min(
    Math.abs(b1.centroid.x - b2.centroid.x),
    Math.abs(b1.centroid.y - b2.centroid.y)
  );

  const shouldKeep =
    (distances[0] <= mean + std * sigma || distances[0] <= fontsize * (1 + gamma)) &&
    (std < stdThreshold || (maxPolyDistance === 0 && maxCentroidAlignment < 5));

  if (shouldKeep) {
    return [regionIndices];
  } else {
    // Remove the largest edge and find connected components of remaining MST
    const remainingEdges = edgesSorted.slice(1);
    const subComponents = findConnectedComponents(
      quads.length,
      remainingEdges.map((e) => [e.u, e.v])
    );

    // Only keep components that contain nodes from our regionIndices
    const regionSet = new Set(regionIndices);
    const result: number[][] = [];
    for (const comp of subComponents) {
      const relevant = Array.from(comp).filter((n) => regionSet.has(n));
      if (relevant.length > 0) {
        result.push(...splitTextRegion(quads, relevant, _width, _height, gamma, sigma));
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// mergeTextRegions — aligned with merge_bboxes_text_region()
// ---------------------------------------------------------------------------

type MergedGroup = {
  quads: InternalQuad[];
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

function mergeTextRegions(quads: InternalQuad[], width: number, height: number): MergedGroup[] {
  const n = quads.length;
  if (n === 0) {
    return [];
  }

  // Step 1: build graph — edges where canMergeRegion is true
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        canMergeRegion(quads[i], quads[j], {
          aspectRatioTol: 1.3,
          fontSizeRatioTol: 2,
          charGapTolerance: 1,
          charGapTolerance2: 3,
        })
      ) {
        edges.push([i, j]);
      }
    }
  }

  // Step 2: find connected components
  const components = findConnectedComponents(n, edges);

  // Step 3: split each component using MST analysis
  const regionGroups: number[][] = [];
  for (const comp of components) {
    const indices = Array.from(comp);
    regionGroups.push(...splitTextRegion(quads, indices, width, height));
  }

  // Step 4: post-process each group
  const results: MergedGroup[] = [];
  for (const group of regionGroups) {
    if (group.length === 0) {
      continue;
    }

    const txtlns = group.map((i) => quads[i]);

    // Average fg/bg colors
    const fgR = Math.round(txtlns.reduce((s, q) => s + q.fgColor[0], 0) / txtlns.length);
    const fgG = Math.round(txtlns.reduce((s, q) => s + q.fgColor[1], 0) / txtlns.length);
    const fgB = Math.round(txtlns.reduce((s, q) => s + q.fgColor[2], 0) / txtlns.length);
    const bgR = Math.round(txtlns.reduce((s, q) => s + q.bgColor[0], 0) / txtlns.length);
    const bgG = Math.round(txtlns.reduce((s, q) => s + q.bgColor[1], 0) / txtlns.length);
    const bgB = Math.round(txtlns.reduce((s, q) => s + q.bgColor[2], 0) / txtlns.length);

    // Majority vote for direction
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

    // Sort textlines by reading order
    let sortedIndices: number[];
    if (majorityDir === "h") {
      sortedIndices = [...group].sort((a, b) => quads[a].centroid.y - quads[b].centroid.y);
    } else {
      sortedIndices = [...group].sort((a, b) => -quads[a].centroid.x + quads[b].centroid.x);
    }

    const sortedQuads = sortedIndices.map((i) => quads[i]);

    results.push({
      quads: sortedQuads,
      fgColor: [fgR, fgG, fgB],
      bgColor: [bgR, bgG, bgB],
    });
  }

  return results;
}

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

  // Convex hull quad — take convex hull of all quad points, then pick 4 representative corners
  const allPoints: Point2D[] = [];
  for (const q of txtlns) {
    allPoints.push(...q.pts);
  }
  const hull = convexHull(allPoints);

  // Approximate the hull as a 4-point quad (minimum bounding quad)
  // Use the extremes of the hull
  let quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  if (hull.length >= 4) {
    // Use sort_pnts equivalent on the hull bounding corners
    const hullMinX = Math.min(...hull.map((p) => p.x));
    const hullMinY = Math.min(...hull.map((p) => p.y));
    const hullMaxX = Math.max(...hull.map((p) => p.x));
    const hullMaxY = Math.max(...hull.map((p) => p.y));
    quad = [
      { x: hullMinX, y: hullMinY },
      { x: hullMaxX, y: hullMinY },
      { x: hullMaxX, y: hullMaxY },
      { x: hullMinX, y: hullMaxY },
    ];
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
    fgColor,
    bgColor,
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
