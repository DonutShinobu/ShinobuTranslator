import type { QuadPoint, TextRegion } from "../../types";
import { convexHull as convexHullImpl } from "../utils";

// ---------------------------------------------------------------------------
// Quad type
// ---------------------------------------------------------------------------

export type Quad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

// ---------------------------------------------------------------------------
// Convex hull re-export
// ---------------------------------------------------------------------------

export const convexHull = convexHullImpl;

// ---------------------------------------------------------------------------
// Mini-box sorting & minimum-area rectangle (from old geometry.ts)
// ---------------------------------------------------------------------------

export function sortMiniBoxPoints(points: QuadPoint[]): Quad {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  let index1 = 0;
  let index2 = 1;
  let index3 = 2;
  let index4 = 3;

  if (sorted[1].y > sorted[0].y) {
    index1 = 0;
    index4 = 1;
  } else {
    index1 = 1;
    index4 = 0;
  }
  if (sorted[3].y > sorted[2].y) {
    index2 = 2;
    index3 = 3;
  } else {
    index2 = 3;
    index3 = 2;
  }

  return [
    { x: sorted[index1].x, y: sorted[index1].y },
    { x: sorted[index2].x, y: sorted[index2].y },
    { x: sorted[index3].x, y: sorted[index3].y },
    { x: sorted[index4].x, y: sorted[index4].y },
  ];
}

export function minAreaRect(points: QuadPoint[]): { box: Quad; shortSide: number } | null {
  if (points.length === 0) {
    return null;
  }

  const hull = convexHull(points);
  if (hull.length === 0) {
    return null;
  }
  if (hull.length === 1) {
    const p = hull[0];
    const box: Quad = [
      { x: p.x, y: p.y },
      { x: p.x + 1, y: p.y },
      { x: p.x + 1, y: p.y + 1 },
      { x: p.x, y: p.y + 1 },
    ];
    return { box, shortSide: 1 };
  }

  let bestArea = Number.POSITIVE_INFINITY;
  let bestWidth = 0;
  let bestHeight = 0;
  let bestBox: Quad | null = null;

  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const edgeNorm = Math.hypot(edgeX, edgeY);
    if (edgeNorm <= 1e-6) {
      continue;
    }

    const ux = edgeX / edgeNorm;
    const uy = edgeY / edgeNorm;
    const vx = -uy;
    const vy = ux;

    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;

    for (const point of hull) {
      const pu = point.x * ux + point.y * uy;
      const pv = point.x * vx + point.y * vy;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }

    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (area >= bestArea) {
      continue;
    }

    bestArea = area;
    bestWidth = width;
    bestHeight = height;
    bestBox = sortMiniBoxPoints([
      { x: ux * minU + vx * minV, y: uy * minU + vy * minV },
      { x: ux * maxU + vx * minV, y: uy * maxU + vy * minV },
      { x: ux * maxU + vx * maxV, y: uy * maxU + vy * maxV },
      { x: ux * minU + vx * maxV, y: uy * minU + vy * maxV },
    ]);
  }

  if (!bestBox) {
    return null;
  }
  return {
    box: bestBox,
    shortSide: Math.min(bestWidth, bestHeight),
  };
}

// ---------------------------------------------------------------------------
// Quad helpers (from typesetGeometry.ts)
// ---------------------------------------------------------------------------

/**
 * Compute rotation angle from quad's top edge.
 * Returns angle in radians.
 */
export function quadAngle(quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]): number {
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
}

/**
 * Compute the width and height of the quad (from its edges).
 */
export function quadDimensions(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): { width: number; height: number } {
  const topW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const botW = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
  const leftH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  const rightH = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
  return { width: (topW + botW) / 2, height: (leftH + rightH) / 2 };
}

export function cloneQuad(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return [
    { x: quad[0].x, y: quad[0].y },
    { x: quad[1].x, y: quad[1].y },
    { x: quad[2].x, y: quad[2].y },
    { x: quad[3].x, y: quad[3].y },
  ];
}

export function cloneRegionForTypeset(region: TextRegion): TextRegion {
  return {
    ...region,
    box: { ...region.box },
    quad: region.quad ? cloneQuad(region.quad) : undefined,
  };
}

export function boxToQuad(region: TextRegion): Quad {
  const x0 = region.box.x;
  const y0 = region.box.y;
  const x1 = region.box.x + region.box.width;
  const y1 = region.box.y + region.box.height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function getRegionQuad(region: TextRegion): Quad {
  if (region.quad) {
    return cloneQuad(region.quad);
  }
  return boxToQuad(region);
}

export function quadCenter(quad: Quad): { x: number; y: number } {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

export function rotatePoint(point: QuadPoint, cx: number, cy: number, angle: number): QuadPoint {
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

export function rotateQuad(quad: Quad, cx: number, cy: number, angle: number): Quad {
  return [
    rotatePoint(quad[0], cx, cy, angle),
    rotatePoint(quad[1], cx, cy, angle),
    rotatePoint(quad[2], cx, cy, angle),
    rotatePoint(quad[3], cx, cy, angle),
  ];
}

export function quadBounds(quad: Quad): { minX: number; minY: number; maxX: number; maxY: number } {
  const minX = Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const minY = Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const maxX = Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const maxY = Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  return { minX, minY, maxX, maxY };
}

export function scaleQuadFromOrigin(
  quad: Quad,
  xfact: number,
  yfact: number,
  originX: number,
  originY: number,
): Quad {
  return [
    {
      x: originX + (quad[0].x - originX) * xfact,
      y: originY + (quad[0].y - originY) * yfact,
    },
    {
      x: originX + (quad[1].x - originX) * xfact,
      y: originY + (quad[1].y - originY) * yfact,
    },
    {
      x: originX + (quad[2].x - originX) * xfact,
      y: originY + (quad[2].y - originY) * yfact,
    },
    {
      x: originX + (quad[3].x - originX) * xfact,
      y: originY + (quad[3].y - originY) * yfact,
    },
  ];
}

export function updateRegionGeometryFromQuad(region: TextRegion, quad: Quad): void {
  const bounds = quadBounds(quad);
  const x = Math.floor(bounds.minX);
  const y = Math.floor(bounds.minY);
  const right = Math.ceil(bounds.maxX);
  const bottom = Math.ceil(bounds.maxY);
  region.quad = quad;
  region.box = {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

// ---------------------------------------------------------------------------
// Offscreen-to-canvas coordinate mapping
// ---------------------------------------------------------------------------

export function mapOffscreenPointToCanvas(
  region: TextRegion,
  point: QuadPoint,
  offscreenWidth: number,
  offscreenHeight: number,
  boxPadding: number,
  strokePadding: number,
): QuadPoint {
  const drawX = region.box.x + boxPadding - strokePadding;
  const drawY = region.box.y + boxPadding - strokePadding;
  const quad = region.quad;
  if (!quad) {
    return { x: drawX + point.x, y: drawY + point.y };
  }

  const angle = quadAngle(quad);
  const isRotated = Math.abs(angle) > 0.01;
  if (!isRotated) {
    return { x: drawX + point.x, y: drawY + point.y };
  }

  const { width: qw, height: qh } = quadDimensions(quad);
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const sx = qw / Math.max(1, offscreenWidth);
  const sy = qh / Math.max(1, offscreenHeight);
  const s = Math.min(sx, sy);
  const localX = (point.x - offscreenWidth / 2) * s;
  const localY = (point.y - offscreenHeight / 2) * s;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos,
  };
}

export function mapOffscreenRectToCanvasQuad(
  region: TextRegion,
  box: { x: number; y: number; width: number; height: number },
  offscreenWidth: number,
  offscreenHeight: number,
  boxPadding: number,
  strokePadding: number,
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  const p0 = mapOffscreenPointToCanvas(
    region,
    { x: box.x, y: box.y },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p1 = mapOffscreenPointToCanvas(
    region,
    { x: box.x + box.width, y: box.y },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p2 = mapOffscreenPointToCanvas(
    region,
    { x: box.x + box.width, y: box.y + box.height },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  const p3 = mapOffscreenPointToCanvas(
    region,
    { x: box.x, y: box.y + box.height },
    offscreenWidth,
    offscreenHeight,
    boxPadding,
    strokePadding,
  );
  return [p0, p1, p2, p3];
}