import type { Rect, QuadPoint } from "../types";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function polygonSignedArea(points: { x: number; y: number }[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

export function polygonArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) {
    return 0;
  }
  return Math.abs(polygonSignedArea(points));
}

export function rectIou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) {
    return 0;
  }
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface ScoredBox {
  box: Rect;
  score: number;
  index?: number;
}

export function nmsBoxes(items: ScoredBox[], iouThreshold: number): ScoredBox[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const suppressed = new Set<number>();
  const kept: ScoredBox[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (suppressed.has(i)) {
      continue;
    }
    const current = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (suppressed.has(j)) {
        continue;
      }
      if (rectIou(current.box, sorted[j].box) > iouThreshold) {
        suppressed.add(j);
      }
    }
    kept.push(current);
  }
  return kept;
}

export function normalizeTextDeep(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeTextLight(text: string): string {
  return text.trim();
}

export function convexHull(points: QuadPoint[]): QuadPoint[] {
  if (points.length <= 1) {
    return points.map((point) => ({ ...point }));
  }
  const unique = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()].sort(
    (a, b) => a.x - b.x || a.y - b.y
  );
  if (unique.length <= 2) {
    return unique;
  }

  const cross = (o: QuadPoint, a: QuadPoint, b: QuadPoint): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: QuadPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: QuadPoint[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function convexHullArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) {
    return 0;
  }
  return polygonArea(convexHull(points as QuadPoint[]));
}

export class UnionFind {
  parent: number[];
  rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
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
