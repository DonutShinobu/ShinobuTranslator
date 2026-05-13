import { PSM, createWorker } from "tesseract.js";
import type { Rect, TextRegion } from "../../types";
import { connectedComponents, mergeRects, makeRegion } from "./onnxDetect";
import { clamp, nmsBoxes, normalizeTextDeep } from "../utils";

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
    const text = normalizeTextDeep(unit.text);
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

export async function detectByHeuristic(image: HTMLImageElement): Promise<TextRegion[]> {
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

export async function detectByTesseract(image: HTMLImageElement): Promise<TextRegion[]> {
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