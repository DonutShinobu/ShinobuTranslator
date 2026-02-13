import * as ort from "onnxruntime-web/all";
import { PSM, createWorker } from "tesseract.js";
import type { Rect, TextRegion } from "../types";
import { getModelSession } from "../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../runtime/onnx";
import type { RuntimeProvider, WebNnDeviceType } from "../runtime/onnx";

type LetterboxResult = {
  input: Float32Array;
  size: number;
  ratio: number;
  unpaddedWidth: number;
  unpaddedHeight: number;
};

type TessBbox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type TessUnit = {
  text: string;
  confidence: number;
  bbox: TessBbox;
};

type BBoxScore = {
  box: Rect;
  score: number;
};

type Point = {
  x: number;
  y: number;
};

type Quad = [Point, Point, Point, Point];

type MaskComponent = {
  boundary: Point[];
};

export type DetectOutput = {
  regions: TextRegion[];
  rawMaskCanvas: HTMLCanvasElement | null;
  actualProvider?: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundHalfToEven(value: number): number {
  const base = Math.floor(value);
  const diff = value - base;
  if (diff < 0.5) {
    return base;
  }
  if (diff > 0.5) {
    return base + 1;
  }
  return base % 2 === 0 ? base : base + 1;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points: Point[]): number {
  if (points.length < 3) {
    return 0;
  }
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    acc += p.x * q.y - p.y * q.x;
  }
  return Math.abs(acc) * 0.5;
}

function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) {
    return 0;
  }
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    acc += distance(points[i], points[(i + 1) % points.length]);
  }
  return acc;
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonScoreFast(scoreMap: Float32Array, width: number, height: number, polygon: Point[]): number {
  if (polygon.length < 3) {
    return 0;
  }
  const minX = clamp(Math.floor(Math.min(...polygon.map((point) => point.x))), 0, width - 1);
  const maxX = clamp(Math.ceil(Math.max(...polygon.map((point) => point.x))), minX, width - 1);
  const minY = clamp(Math.floor(Math.min(...polygon.map((point) => point.y))), 0, height - 1);
  const maxY = clamp(Math.ceil(Math.max(...polygon.map((point) => point.y))), minY, height - 1);

  let sum = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!pointInPolygon(x + 0.5, y + 0.5, polygon)) {
        continue;
      }
      sum += scoreMap[y * width + x];
      count += 1;
    }
  }
  if (count === 0) {
    return 0;
  }
  return sum / count;
}

function sortMiniBoxPoints(points: Point[]): Quad {
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
    { x: sorted[index4].x, y: sorted[index4].y }
  ];
}

function convexHull(points: Point[]): Point[] {
  if (points.length <= 1) {
    return points.map((point) => ({ ...point }));
  }
  const unique = [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()].sort(
    (a, b) => a.x - b.x || a.y - b.y
  );
  if (unique.length <= 2) {
    return unique;
  }

  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point[] = [];
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

function minAreaRect(points: Point[]): { box: Quad; shortSide: number } | null {
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
      { x: p.x, y: p.y + 1 }
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
      { x: ux * minU + vx * maxV, y: uy * minU + vy * maxV }
    ]);
  }

  if (!bestBox) {
    return null;
  }
  return {
    box: bestBox,
    shortSide: Math.min(bestWidth, bestHeight)
  };
}

function unclipBox(box: Quad, unclipRatio: number): Quad {
  const area = polygonArea(box);
  const perimeter = polygonPerimeter(box);
  if (area <= 0 || perimeter <= 1e-6) {
    return box;
  }
  const distanceValue = (area * unclipRatio) / perimeter;

  const center = {
    x: (box[0].x + box[1].x + box[2].x + box[3].x) / 4,
    y: (box[0].y + box[1].y + box[2].y + box[3].y) / 4
  };
  const widthVec = { x: box[1].x - box[0].x, y: box[1].y - box[0].y };
  const heightVec = { x: box[3].x - box[0].x, y: box[3].y - box[0].y };
  const width = Math.hypot(widthVec.x, widthVec.y);
  const height = Math.hypot(heightVec.x, heightVec.y);
  if (width <= 1e-6 || height <= 1e-6) {
    return box;
  }

  const ux = widthVec.x / width;
  const uy = widthVec.y / width;
  const vx = heightVec.x / height;
  const vy = heightVec.y / height;
  const halfW = width * 0.5 + distanceValue;
  const halfH = height * 0.5 + distanceValue;

  return [
    { x: center.x - ux * halfW - vx * halfH, y: center.y - uy * halfW - vy * halfH },
    { x: center.x + ux * halfW - vx * halfH, y: center.y + uy * halfW - vy * halfH },
    { x: center.x + ux * halfW + vx * halfH, y: center.y + uy * halfW + vy * halfH },
    { x: center.x - ux * halfW + vx * halfH, y: center.y - uy * halfW + vy * halfH }
  ];
}

function quadToRect(quad: Quad, imageWidth: number, imageHeight: number): Rect {
  const minX = Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const minY = Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const maxX = Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const maxY = Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const x = clamp(Math.floor(minX), 0, imageWidth - 1);
  const y = clamp(Math.floor(minY), 0, imageHeight - 1);
  const right = clamp(Math.ceil(maxX), x + 1, imageWidth);
  const bottom = clamp(Math.ceil(maxY), y + 1, imageHeight);
  return { x, y, width: right - x, height: bottom - y };
}

function inferDirectionFromQuad(quad: Quad): "h" | "v" {
  const width = (distance(quad[0], quad[1]) + distance(quad[2], quad[3])) * 0.5;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) * 0.5;
  return height > width ? "v" : "h";
}

function makeRegionFromQuad(quad: Quad, imageWidth: number, imageHeight: number, score: number): TextRegion {
  return {
    id: crypto.randomUUID(),
    box: quadToRect(quad, imageWidth, imageHeight),
    quad,
    direction: inferDirectionFromQuad(quad),
    prob: score,
    sourceText: "",
    translatedText: ""
  };
}

function rectToQuad(box: Rect): [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number }
] {
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
}

function inferDirection(box: Rect): "h" | "v" {
  return box.height > box.width ? "v" : "h";
}

function makeRegion(box: Rect): TextRegion {
  return {
    id: crypto.randomUUID(),
    box,
    quad: rectToQuad(box),
    direction: inferDirection(box),
    sourceText: "",
    translatedText: ""
  };
}

function binaryMaskToCanvas(mask: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("文本检测遮罩输出无法创建画布上下文");
  }
  const image = ctx.createImageData(width, height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const value = mask[i] > 0 ? 255 : 0;
    image.data[p] = value;
    image.data[p + 1] = value;
    image.data[p + 2] = value;
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function scaleMaskToOriginal(maskCanvas: HTMLCanvasElement, image: HTMLImageElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = image.naturalWidth;
  out.height = image.naturalHeight;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("文本检测遮罩缩放失败");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);
  const imageData = ctx.getImageData(0, 0, out.width, out.height);
  const data = imageData.data;
  for (let p = 0; p < data.length; p += 4) {
    const value = data[p] > 127 ? 255 : 0;
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
}

function buildMaskCanvasFromBinary(mask: Uint8Array, width: number, height: number, image: HTMLImageElement): HTMLCanvasElement {
  return scaleMaskToOriginal(binaryMaskToCanvas(mask, width, height), image);
}

function intersectsOrNear(a: Rect, b: Rect, gap: number): boolean {
  return !(
    a.x + a.width + gap < b.x ||
    b.x + b.width + gap < a.x ||
    a.y + a.height + gap < b.y ||
    b.y + b.height + gap < a.y
  );
}

function mergeRects(rects: Rect[], gap: number): Rect[] {
  const merged: Rect[] = [];
  for (const rect of rects) {
    let mergedCurrent = false;
    for (let i = 0; i < merged.length; i += 1) {
      if (!intersectsOrNear(rect, merged[i], gap)) {
        continue;
      }
      const left = Math.min(rect.x, merged[i].x);
      const top = Math.min(rect.y, merged[i].y);
      const right = Math.max(rect.x + rect.width, merged[i].x + merged[i].width);
      const bottom = Math.max(rect.y + rect.height, merged[i].y + merged[i].height);
      merged[i] = { x: left, y: top, width: right - left, height: bottom - top };
      mergedCurrent = true;
      break;
    }
    if (!mergedCurrent) {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function rectIou(a: Rect, b: Rect): number {
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

function nmsBoxes(items: BBoxScore[], iouThreshold: number): BBoxScore[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: BBoxScore[] = [];
  for (const current of sorted) {
    let suppressed = false;
    for (const prev of kept) {
      if (rectIou(current.box, prev.box) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept.push(current);
    }
  }
  return kept;
}

function pickBlkTensor(outputs: ort.InferenceSession.ReturnType): ort.Tensor | null {
  const byName = outputs.blk;
  if (byName && byName.dims.length === 3 && byName.dims[2] >= 6) {
    return byName;
  }
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[2] >= 6) {
      return value;
    }
  }
  return null;
}

function pickDetTensor(outputs: ort.InferenceSession.ReturnType): ort.Tensor | null {
  const byName = outputs.det;
  if (byName && byName.dims.length === 4 && byName.dims[1] >= 1) {
    return byName;
  }
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 4 && value.dims[1] >= 1 && value.dims[2] >= 64 && value.dims[3] >= 64) {
      return value;
    }
  }
  return null;
}

function boxesFromBlk(
  tensor: ort.Tensor,
  inputSize: number,
  unpaddedWidth: number,
  unpaddedHeight: number
): BBoxScore[] {
  if (!(tensor.data instanceof Float32Array)) {
    return [];
  }
  const data = tensor.data;
  const rows = tensor.dims[1] ?? 0;
  const cols = tensor.dims[2] ?? 0;
  if (rows <= 0 || cols < 6) {
    return [];
  }

  const candidates: BBoxScore[] = [];
  const confThreshold = 0.35;
  for (let i = 0; i < rows; i += 1) {
    const base = i * cols;
    const cx = data[base];
    const cy = data[base + 1];
    const w = data[base + 2];
    const h = data[base + 3];
    const obj = data[base + 4];
    if (!Number.isFinite(cx + cy + w + h + obj)) {
      continue;
    }
    let cls = 1;
    for (let k = 5; k < cols; k += 1) {
      cls = Math.max(cls, data[base + k]);
    }
    const score = obj * cls;
    if (score < confThreshold) {
      continue;
    }

    const x = cx - w / 2;
    const y = cy - h / 2;
    const left = clamp(Math.floor(x), 0, inputSize - 1);
    const top = clamp(Math.floor(y), 0, inputSize - 1);
    const right = clamp(Math.ceil(x + w), left + 1, inputSize);
    const bottom = clamp(Math.ceil(y + h), top + 1, inputSize);
    if (left >= unpaddedWidth || top >= unpaddedHeight) {
      continue;
    }

    const clippedRight = Math.min(right, unpaddedWidth);
    const clippedBottom = Math.min(bottom, unpaddedHeight);
    const boxWidth = clippedRight - left;
    const boxHeight = clippedBottom - top;
    if (boxWidth < 6 || boxHeight < 6) {
      continue;
    }

    const ratio = (boxWidth * boxHeight) / (unpaddedWidth * unpaddedHeight);
    if (ratio < 0.00004 || ratio > 0.1) {
      continue;
    }

    candidates.push({
      box: { x: left, y: top, width: boxWidth, height: boxHeight },
      score
    });
  }

  const picked = nmsBoxes(candidates, 0.35).slice(0, 96);
  return picked;
}

function normalizeText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasJapanese(text: string): boolean {
  return /[ぁ-んァ-ン一-龯々ー]/.test(text);
}

function coreTextLength(text: string): number {
  return text.replace(/[\s\-–—>\/|.,。・…:：;；!?！？()（）\[\]【】「」『』]/g, "").length;
}

function isBbox(value: unknown): value is TessBbox {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.x0 === "number" &&
    typeof record.y0 === "number" &&
    typeof record.x1 === "number" &&
    typeof record.y1 === "number"
  );
}

function extractUnits(raw: unknown): TessUnit[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TessUnit[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string" || typeof record.confidence !== "number" || !isBbox(record.bbox)) {
      continue;
    }
    out.push({
      text: record.text,
      confidence: record.confidence,
      bbox: record.bbox
    });
  }
  return out;
}

function toRect(bbox: TessBbox, scale: number, imageWidth: number, imageHeight: number, padding: number): Rect {
  const x = clamp(Math.floor(bbox.x0 / scale) - padding, 0, imageWidth - 1);
  const y = clamp(Math.floor(bbox.y0 / scale) - padding, 0, imageHeight - 1);
  const right = clamp(Math.ceil(bbox.x1 / scale) + padding, x + 1, imageWidth);
  const bottom = clamp(Math.ceil(bbox.y1 / scale) + padding, y + 1, imageHeight);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function preprocessForTesseract(image: HTMLImageElement): { canvas: HTMLCanvasElement; scale: number } {
  const maxSide = 2200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Tesseract 检测预处理阶段无法创建画布上下文");
  }
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const boosted = clamp((gray - 128) * 1.4 + 128, 0, 255);
    data[i] = boosted;
    data[i + 1] = boosted;
    data[i + 2] = boosted;
  }
  ctx.putImageData(imageData, 0, 0);
  return { canvas, scale };
}

function buildRegionsFromUnits(
  units: TessUnit[],
  scale: number,
  imageWidth: number,
  imageHeight: number,
  minConfidence: number
): TextRegion[] {
  const imageArea = imageWidth * imageHeight;
  const padding = Math.max(4, Math.round(Math.min(imageWidth, imageHeight) * 0.008));
  const rects: Rect[] = [];

  for (const unit of units) {
    const text = normalizeText(unit.text);
    if (!text) {
      continue;
    }
    if (!hasJapanese(text) && coreTextLength(text) < 2) {
      continue;
    }
    if (unit.confidence < minConfidence) {
      continue;
    }
    const rect = toRect(unit.bbox, scale, imageWidth, imageHeight, padding);
    const area = rect.width * rect.height;
    const ratio = area / imageArea;
    const aspect = rect.width / Math.max(1, rect.height);
    if (ratio < 0.00005 || ratio > 0.04) {
      continue;
    }
    if (aspect > 2.2) {
      continue;
    }
    if (rect.width > imageWidth * 0.35 || rect.height > imageHeight * 0.45) {
      continue;
    }
    rects.push(rect);
  }

  if (rects.length === 0) {
    return [];
  }

  const scored = rects.map((box) => ({ box, score: box.width * box.height }));
  const merged = nmsBoxes(scored, 0.2)
    .map((item) => item.box)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 72)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return merged.map(makeRegion);
}

async function buildWorker() {
  try {
    return await createWorker("jpn_vert+jpn");
  } catch {
    return createWorker("jpn");
  }
}

function preprocessLetterbox(image: HTMLImageElement, size: number): LetterboxResult {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const ratio = Math.min(size / height, size / width);
  const unpaddedWidth = Math.max(1, Math.round(width * ratio));
  const unpaddedHeight = Math.max(1, Math.round(height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("ONNX 检测预处理失败：无法创建画布");
  }
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, unpaddedWidth, unpaddedHeight);

  const data = ctx.getImageData(0, 0, size, size).data;
  const input = new Float32Array(1 * 3 * size * size);
  const hw = size * size;
  for (let i = 0, p = 0; i < hw; i += 1, p += 4) {
    input[i] = data[p] / 255;
    input[hw + i] = data[p + 1] / 255;
    input[2 * hw + i] = data[p + 2] / 255;
  }

  return {
    input,
    size,
    ratio,
    unpaddedWidth,
    unpaddedHeight
  };
}

function pickSegTensor(outputs: ort.InferenceSession.ReturnType): ort.Tensor {
  const byName = outputs.seg;
  if (byName) {
    return byName;
  }

  for (const value of Object.values(outputs)) {
    if (value.dims.length === 4 && value.dims[1] === 1) {
      return value;
    }
  }
  throw new Error("ONNX 检测结果中未找到 seg 输出");
}

function buildBinaryMaskFromTensor(
  tensor: ort.Tensor,
  unpaddedWidth: number,
  unpaddedHeight: number,
  threshold: number,
  channelIndex = 0
): { mask: Uint8Array; width: number; height: number } | null {
  if (!(tensor.data instanceof Float32Array)) {
    return null;
  }
  const dims = tensor.dims;
  if (dims.length !== 4) {
    return null;
  }

  const channels = dims[1] ?? 0;
  const rawHeight = dims[2] ?? 0;
  const rawWidth = dims[3] ?? 0;
  if (channels <= 0 || rawWidth <= 0 || rawHeight <= 0) {
    return null;
  }

  const width = Math.min(unpaddedWidth, rawWidth);
  const height = Math.min(unpaddedHeight, rawHeight);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const source = tensor.data;
  const channelStride = rawWidth * rawHeight;
  const channel = clamp(Math.floor(channelIndex), 0, channels - 1);
  const channelOffset = channel * channelStride;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = channelOffset + y * rawWidth;
    const destRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = destRow + x;
      mask[idx] = source[sourceRow + x] > threshold ? 1 : 0;
    }
  }

  return { mask, width, height };
}

function connectedComponents(mask: Uint8Array, width: number, height: number): Rect[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const out: Rect[] = [];

  for (let idx = 0; idx < total; idx += 1) {
    if (mask[idx] === 0 || visited[idx] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = idx;
    tail += 1;
    visited[idx] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const xStart = Math.max(0, x - 1);
      const xEnd = Math.min(width - 1, x + 1);
      const yStart = Math.max(0, y - 1);
      const yEnd = Math.min(height - 1, y + 1);
      for (let ny = yStart; ny <= yEnd; ny += 1) {
        for (let nx = xStart; nx <= xEnd; nx += 1) {
          if (nx === x && ny === y) {
            continue;
          }
          const next = ny * width + nx;
          if (visited[next] === 1 || mask[next] === 0) {
            continue;
          }
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const area = boxWidth * boxHeight;
    const density = count / area;
    if (count < 10 || boxWidth < 4 || boxHeight < 4 || density < 0.03) {
      continue;
    }
    out.push({ x: minX, y: minY, width: boxWidth, height: boxHeight });
  }
  return out;
}

function extractMaskComponents(mask: Uint8Array, width: number, height: number): MaskComponent[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const out: MaskComponent[] = [];

  for (let idx = 0; idx < total; idx += 1) {
    if (mask[idx] === 0 || visited[idx] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = idx;
    tail += 1;
    visited[idx] = 1;

    const pixels: number[] = [];

    while (head < tail) {
      const current = queue[head];
      head += 1;
      pixels.push(current);

      const x = current % width;
      const y = Math.floor(current / width);
      const xStart = Math.max(0, x - 1);
      const xEnd = Math.min(width - 1, x + 1);
      const yStart = Math.max(0, y - 1);
      const yEnd = Math.min(height - 1, y + 1);
      for (let ny = yStart; ny <= yEnd; ny += 1) {
        for (let nx = xStart; nx <= xEnd; nx += 1) {
          if (nx === x && ny === y) {
            continue;
          }
          const next = ny * width + nx;
          if (visited[next] === 1 || mask[next] === 0) {
            continue;
          }
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    if (pixels.length === 0) {
      continue;
    }

    const boundary: Point[] = [];
    for (const pixel of pixels) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      let isBoundary = false;
      for (let ny = y - 1; ny <= y + 1 && !isBoundary; ny += 1) {
        for (let nx = x - 1; nx <= x + 1; nx += 1) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            isBoundary = true;
            break;
          }
          if (mask[ny * width + nx] === 0) {
            isBoundary = true;
            break;
          }
        }
      }
      if (isBoundary) {
        boundary.push({ x, y });
      }
    }

    if (boundary.length < 4) {
      continue;
    }

    out.push({ boundary });

    if (out.length >= 1000) {
      break;
    }
  }

  return out;
}

function mapQuadToOriginal(
  quad: Quad,
  srcWidth: number,
  srcHeight: number,
  destWidth: number,
  destHeight: number
): Quad {
  const mapped = quad.map((point) => ({
    x: clamp(roundHalfToEven((point.x / srcWidth) * destWidth), 0, destWidth),
    y: clamp(roundHalfToEven((point.y / srcHeight) * destHeight), 0, destHeight)
  }));
  return [mapped[0], mapped[1], mapped[2], mapped[3]];
}

function detectCtdRegionsFromDetTensor(
  detTensor: ort.Tensor,
  image: HTMLImageElement,
  prep: LetterboxResult
): TextRegion[] {
  if (!(detTensor.data instanceof Float32Array)) {
    return [];
  }

  const dims = detTensor.dims;
  if (dims.length !== 4 || dims[1] < 1) {
    return [];
  }

  const rawHeight = dims[2];
  const rawWidth = dims[3];
  if (rawWidth <= 0 || rawHeight <= 0) {
    return [];
  }

  const width = Math.min(prep.unpaddedWidth, rawWidth);
  const height = Math.min(prep.unpaddedHeight, rawHeight);
  if (width <= 0 || height <= 0) {
    return [];
  }

  const channelOffset = 0;
  const map = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  const source = detTensor.data;
  for (let y = 0; y < height; y += 1) {
    const sourceRow = channelOffset + y * rawWidth;
    const destRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = source[sourceRow + x];
      const idx = destRow + x;
      map[idx] = value;
      mask[idx] = value > 0.3 ? 1 : 0;
    }
  }

  const components = extractMaskComponents(mask, width, height);
  const regions: TextRegion[] = [];

  for (const component of components) {
    const contour = convexHull(component.boundary);
    const mini = minAreaRect(contour);
    if (!mini || mini.shortSide < 2) {
      continue;
    }

    const score = polygonScoreFast(map, width, height, contour);
    if (score <= 0.6) {
      continue;
    }

    const expanded = unclipBox(mini.box, 1.5);
    const refined = minAreaRect(expanded);
    if (!refined) {
      continue;
    }

    const mapped = mapQuadToOriginal(refined.box, width, height, image.naturalWidth, image.naturalHeight);
    const region = makeRegionFromQuad(mapped, image.naturalWidth, image.naturalHeight, score);
    if (region.box.width < 1 || region.box.height < 1) {
      continue;
    }
    regions.push(region);
  }

  regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return regions;
}

function mapBoxesToOriginal(
  boxes: Rect[],
  image: HTMLImageElement,
  prep: LetterboxResult,
  padRatio = 0.15,
  maxAreaRatio = 0.18
): Rect[] {
  const scale = 1 / prep.ratio;
  const mapped: Rect[] = [];
  const imageArea = image.naturalWidth * image.naturalHeight;

  for (const box of boxes) {
    const clippedRight = Math.min(prep.unpaddedWidth, box.x + box.width);
    const clippedBottom = Math.min(prep.unpaddedHeight, box.y + box.height);
    if (clippedRight <= box.x || clippedBottom <= box.y) {
      continue;
    }

    const x = clamp(Math.floor(box.x * scale), 0, image.naturalWidth - 1);
    const y = clamp(Math.floor(box.y * scale), 0, image.naturalHeight - 1);
    const right = clamp(Math.ceil(clippedRight * scale), x + 1, image.naturalWidth);
    const bottom = clamp(Math.ceil(clippedBottom * scale), y + 1, image.naturalHeight);

    const pad = Math.max(3, Math.round(Math.min(right - x, bottom - y) * padRatio));
    const mappedRect = {
      x: clamp(x - pad, 0, image.naturalWidth - 1),
      y: clamp(y - pad, 0, image.naturalHeight - 1),
      width: clamp(right + pad, 1, image.naturalWidth) - clamp(x - pad, 0, image.naturalWidth - 1),
      height: clamp(bottom + pad, 1, image.naturalHeight) - clamp(y - pad, 0, image.naturalHeight - 1)
    };
    const ratio = (mappedRect.width * mappedRect.height) / imageArea;
    if (ratio < 0.00005 || ratio > maxAreaRatio) {
      continue;
    }
    mapped.push(mappedRect);
  }

  return mapped;
}

function estimateThreshold(grays: Uint8ClampedArray): number {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < grays.length; i += 1) {
    const v = grays[i];
    sum += v;
    sq += v * v;
  }
  const mean = sum / grays.length;
  const variance = Math.max(0, sq / grays.length - mean * mean);
  const stdev = Math.sqrt(variance);
  return clamp(Math.round(mean - stdev * 0.35), 70, 170);
}

async function detectByHeuristic(image: HTMLImageElement): Promise<TextRegion[]> {
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("文本检测阶段无法创建画布上下文");
  }
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const totalPixels = width * height;
  const grays = new Uint8ClampedArray(totalPixels);

  for (let i = 0, p = 0; i < totalPixels; i += 1, p += 4) {
    grays[i] = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
  }
  const threshold = estimateThreshold(grays);
  const dark = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i += 1) {
    dark[i] = grays[i] < threshold ? 1 : 0;
  }

  const mapped = connectedComponents(dark, width, height);
  const scaleX = image.naturalWidth / width;
  const scaleY = image.naturalHeight / height;
  const pad = Math.max(4, Math.round(Math.min(scaleX, scaleY) * 6));
  const imageArea = image.naturalWidth * image.naturalHeight;
  const projected = mapped
    .map((rect) => {
      const x = clamp(Math.floor(rect.x * scaleX) - pad, 0, image.naturalWidth - 1);
      const y = clamp(Math.floor(rect.y * scaleY) - pad, 0, image.naturalHeight - 1);
      const right = clamp(Math.ceil((rect.x + rect.width) * scaleX) + pad, x + 1, image.naturalWidth);
      const bottom = clamp(Math.ceil((rect.y + rect.height) * scaleY) + pad, y + 1, image.naturalHeight);
      return { x, y, width: right - x, height: bottom - y };
    })
    .filter((rect) => {
      const ratio = (rect.width * rect.height) / imageArea;
      return ratio >= 0.00005 && ratio <= 0.18;
    });

  const merged = mergeRects(projected, Math.max(6, Math.round(Math.min(scaleX, scaleY) * 12)));
  const sorted = merged
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 40)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return sorted.map(makeRegion);
}

async function detectByTesseract(image: HTMLImageElement): Promise<TextRegion[]> {
  const worker = await buildWorker();
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1"
    });
    const preprocessed = preprocessForTesseract(image);
    const result = await worker.recognize(preprocessed.canvas);

    const lineUnits = extractUnits(result.data.lines);
    const lineRegions = buildRegionsFromUnits(
      lineUnits,
      preprocessed.scale,
      image.naturalWidth,
      image.naturalHeight,
      35
    );
    if (lineRegions.length > 0) {
      return lineRegions;
    }

    const wordUnits = extractUnits(result.data.words);
    return buildRegionsFromUnits(wordUnits, preprocessed.scale, image.naturalWidth, image.naturalHeight, 45);
  } finally {
    await worker.terminate();
  }
}

async function detectByOnnx(image: HTMLImageElement): Promise<DetectOutput> {
  const primaryHandle = await getModelSession("detector");
  const inputSize = 1024;
  const prep = preprocessLetterbox(image, inputSize);
  const runWithHandle = async (handle: { session: ort.InferenceSession }): Promise<ort.InferenceSession.ReturnType> => {
    const inputName = handle.session.inputNames[0] ?? "images";
    const feeds: Record<string, ort.Tensor> = {
      [inputName]: new ort.Tensor("float32", prep.input, [1, 3, inputSize, inputSize])
    };
    return handle.session.run(feeds);
  };

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;

  let outputs: ort.InferenceSession.ReturnType;
  try {
    outputs = await runWithHandle(primaryHandle);
  } catch (error) {
    const message = toErrorMessage(error);
    const reason = isContextLostRuntimeError(error) ? "context lost" : "run failed";
    if (primaryHandle.provider === "wasm") {
      throw error;
    }

    const fallbackPlans: RuntimeProvider[][] = [];
    if (primaryHandle.provider === "webgpu") {
      fallbackPlans.push(["webnn", "wasm"]);
    }
    fallbackPlans.push(["wasm"]);

    let recovered: ort.InferenceSession.ReturnType | null = null;
    let lastFallbackError: unknown = null;
    console.warn(`[detector] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await getModelSession("detector", preferred);
        recovered = await runWithHandle(handle);
        if (handle.provider !== primaryHandle.provider) {
          console.warn(`[detector] 已回退到 ${handle.provider}`);
          actualProvider = handle.provider;
          actualWebnnDeviceType = handle.webnnDeviceType;
        }
        break;
      } catch (fallbackError) {
        lastFallbackError = fallbackError;
      }
    }

    if (!recovered) {
      const fallbackMessage = lastFallbackError ? toErrorMessage(lastFallbackError) : "未知错误";
      throw new Error(`检测推理失败且回退失败: ${message} | fallback: ${fallbackMessage}`);
    }

    outputs = recovered;
  }

  const detTensor = pickDetTensor(outputs);
  if (detTensor) {
    const regions = detectCtdRegionsFromDetTensor(detTensor, image, prep);

    let maskTensor: ort.Tensor = detTensor;
    try {
      const segTensor = pickSegTensor(outputs);
      if (segTensor.dims.length === 4 && (segTensor.dims[1] ?? 0) >= 1) {
        maskTensor = segTensor;
      }
    } catch {
      // 当前模型无独立 seg 输出时，回退使用 det 通道 0 作为粗遮罩。
    }

    const binaryMask = buildBinaryMaskFromTensor(maskTensor, prep.unpaddedWidth, prep.unpaddedHeight, 0.3, 0);
    if (!binaryMask) {
      return { regions, rawMaskCanvas: null, actualProvider, actualWebnnDeviceType };
    }

    return {
      regions,
      rawMaskCanvas: buildMaskCanvasFromBinary(binaryMask.mask, binaryMask.width, binaryMask.height, image),
      actualProvider,
      actualWebnnDeviceType
    };
  }

  const blkTensor = pickBlkTensor(outputs);
  if (blkTensor) {
    const blkBoxes = boxesFromBlk(blkTensor, inputSize, prep.unpaddedWidth, prep.unpaddedHeight);
    if (blkBoxes.length > 0) {
      const mapped = mapBoxesToOriginal(
        blkBoxes.map((item) => item.box),
        image,
        prep,
        0.08,
        0.1
      )
        .filter((box) => box.width / Math.max(1, box.height) <= 1.8)
        .filter((box) => box.width <= image.naturalWidth * 0.35 && box.height <= image.naturalHeight * 0.45)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 72)
        .sort((a, b) => a.y - b.y || a.x - b.x);

      if (mapped.length > 0) {
        const regions = mapped.map(makeRegion);
        return {
          regions,
          rawMaskCanvas: null,
          actualProvider,
          actualWebnnDeviceType
        };
      }
    }
  }

  const segTensor = pickSegTensor(outputs);
  const binaryMask = buildBinaryMaskFromTensor(segTensor, prep.unpaddedWidth, prep.unpaddedHeight, 0.46, 0);
  if (!binaryMask) {
    return { regions: [], rawMaskCanvas: null, actualProvider, actualWebnnDeviceType };
  }
  const { mask, width, height } = binaryMask;

  const boxes1024 = connectedComponents(mask, width, height);
  const mapped = mapBoxesToOriginal(boxes1024, image, prep, 0.05, 0.08);
  const merged = mergeRects(mapped, 5)
    .filter((box) => box.width / Math.max(1, box.height) <= 1.8)
    .filter((box) => box.width <= image.naturalWidth * 0.35 && box.height <= image.naturalHeight * 0.45)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 64)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  if (merged.length === 0) {
    return { regions: [], rawMaskCanvas: null, actualProvider, actualWebnnDeviceType };
  }

  const regions = merged.map(makeRegion);
  return {
    regions,
    rawMaskCanvas: buildMaskCanvasFromBinary(mask, width, height, image),
    actualProvider,
    actualWebnnDeviceType
  };
}

export async function detectTextRegionsWithMask(image: HTMLImageElement): Promise<DetectOutput> {
  try {
    const onnxResult = await detectByOnnx(image);
    if (onnxResult.regions.length > 0) {
      return onnxResult;
    }
    throw new Error("未找到文本");
  } catch (error) {
    if (error instanceof Error && error.message === "未找到文本") {
      throw error;
    }
    console.warn(`[detect] onnx detector unavailable, fallback to tesseract/heuristic: ${toErrorMessage(error)}`);
  }

  try {
    const tessRegions = await detectByTesseract(image);
    if (tessRegions.length > 0) {
      return {
        regions: tessRegions,
        rawMaskCanvas: null
      };
    }
  } catch (error) {
    console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${toErrorMessage(error)}`);
  }

  const heuristicRegions = await detectByHeuristic(image);
  if (heuristicRegions.length === 0) {
    throw new Error("未找到文本");
  }
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null
  };
}

export async function detectTextRegions(image: HTMLImageElement): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(image);
  return result.regions;
}
