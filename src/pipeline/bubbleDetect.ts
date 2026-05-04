import * as ort from "onnxruntime-web";
import { getModelSession } from "../runtime/modelRegistry";
import type { Rect, TextRegion } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BubbleDetection = {
  box: Rect;
  score: number;
  mask: ImageData;
};

export type BubbleDetectResult = {
  bubbles: BubbleDetection[];
};

// ---------------------------------------------------------------------------
// Preprocessing — letterbox to 640x640, CHW float32 [0,1]
// ---------------------------------------------------------------------------

type LetterboxResult = {
  input: Float32Array;
  size: number;
  ratio: number;
  padX: number;
  padY: number;
};

function preprocessLetterbox(image: HTMLImageElement, size: number): LetterboxResult {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const ratio = Math.min(size / w, size / h);
  const newW = Math.round(w * ratio);
  const newH = Math.round(h * ratio);
  const padX = Math.round((size - newW) / 2);
  const padY = Math.round((size - newH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("气泡检测预处理失败：无法创建画布");

  ctx.fillStyle = "#7f7f7f";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, padX, padY, newW, newH);

  const data = ctx.getImageData(0, 0, size, size).data;
  const input = new Float32Array(3 * size * size);
  const hw = size * size;
  for (let i = 0, p = 0; i < hw; i += 1, p += 4) {
    input[i] = data[p] / 255;
    input[hw + i] = data[p + 1] / 255;
    input[2 * hw + i] = data[p + 2] / 255;
  }
  return { input, size, ratio, padX, padY };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function runBubbleInference(image: HTMLImageElement): Promise<{
  output0: Float32Array;
  output0Shape: readonly number[];
  output1: Float32Array;
  output1Shape: readonly number[];
  prep: LetterboxResult;
}> {
  const handle = await getModelSession("bubble");
  const size = 640;
  const prep = preprocessLetterbox(image, size);

  const inputName = handle.session.inputNames[0] ?? "images";
  const feeds: Record<string, ort.Tensor> = {
    [inputName]: new ort.Tensor("float32", prep.input, [1, 3, size, size]),
  };
  const outputs = await handle.session.run(feeds);

  const outputNames = handle.session.outputNames;
  const out0 = outputs[outputNames[0]];
  const out1 = outputs[outputNames[1]];
  if (!out0 || !out1) {
    throw new Error("气泡检测模型输出张量缺失");
  }

  return {
    output0: out0.data as Float32Array,
    output0Shape: out0.dims,
    output1: out1.data as Float32Array,
    output1Shape: out1.dims,
    prep,
  };
}

// ---------------------------------------------------------------------------
// NMS
// ---------------------------------------------------------------------------

function rectIou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

type ScoredBox = { box: Rect; score: number; index: number };

function nmsBoxes(items: ScoredBox[], iouThreshold: number): ScoredBox[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: ScoredBox[] = [];
  for (const current of sorted) {
    let suppressed = false;
    for (const prev of kept) {
      if (rectIou(current.box, prev.box) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(current);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Decode output0 → boxes + scores + mask coefficients
// ---------------------------------------------------------------------------

const CONF_THRESHOLD = 0.5;
const IOU_THRESHOLD = 0.5;

type RawDetection = {
  box: Rect;
  score: number;
  maskCoeffs: Float32Array;
};

function decodeDetections(
  output0: Float32Array,
  shape: readonly number[],
  prep: LetterboxResult,
  imgW: number,
  imgH: number,
): RawDetection[] {
  // 4(box) + 1(score) + 32(mask coefficients) = 37 for single-class YOLOv8-seg
  if (shape[1] !== 37) {
    throw new Error(`气泡检测模型 output0 通道数异常: 期望 37, 实际 ${shape[1]}`);
  }
  const numCandidates = shape[2];

  const detections: ScoredBox[] = [];
  const coeffsMap = new Map<number, Float32Array>();

  for (let i = 0; i < numCandidates; i++) {
    const cx = output0[0 * numCandidates + i];
    const cy = output0[1 * numCandidates + i];
    const w = output0[2 * numCandidates + i];
    const h = output0[3 * numCandidates + i];
    const score = output0[4 * numCandidates + i];

    if (score < CONF_THRESHOLD) continue;

    const x1 = (cx - w / 2 - prep.padX) / prep.ratio;
    const y1 = (cy - h / 2 - prep.padY) / prep.ratio;
    const bw = w / prep.ratio;
    const bh = h / prep.ratio;

    const clampedX = Math.max(0, Math.min(x1, imgW));
    const clampedY = Math.max(0, Math.min(y1, imgH));
    const clampedW = Math.min(bw, imgW - clampedX);
    const clampedH = Math.min(bh, imgH - clampedY);

    if (clampedW <= 0 || clampedH <= 0) continue;

    const box: Rect = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
    detections.push({ box, score, index: i });

    const coeffs = new Float32Array(32);
    for (let c = 0; c < 32; c++) {
      coeffs[c] = output0[(5 + c) * numCandidates + i];
    }
    coeffsMap.set(i, coeffs);
  }

  const kept = nmsBoxes(detections, IOU_THRESHOLD);

  return kept.map((d) => ({
    box: d.box,
    score: d.score,
    maskCoeffs: coeffsMap.get(d.index)!,
  }));
}

// ---------------------------------------------------------------------------
// Decode proto masks → per-instance ImageData
// ---------------------------------------------------------------------------

function decodeMasks(
  detections: RawDetection[],
  output1: Float32Array,
  output1Shape: readonly number[],
  prep: LetterboxResult,
  imgW: number,
  imgH: number,
): ImageData[] {
  const numProtos = output1Shape[1];
  const maskH = output1Shape[2];
  const maskW = output1Shape[3];

  const masks: ImageData[] = [];

  for (const det of detections) {
    const combined = new Float32Array(maskH * maskW);
    for (let p = 0; p < numProtos; p++) {
      const coeff = det.maskCoeffs[p];
      const protoOffset = p * maskH * maskW;
      for (let j = 0; j < maskH * maskW; j++) {
        combined[j] += coeff * output1[protoOffset + j];
      }
    }

    for (let j = 0; j < combined.length; j++) {
      combined[j] = 1 / (1 + Math.exp(-combined[j]));
    }

    const lbx1 = det.box.x * prep.ratio + prep.padX;
    const lby1 = det.box.y * prep.ratio + prep.padY;
    const lbx2 = (det.box.x + det.box.width) * prep.ratio + prep.padX;
    const lby2 = (det.box.y + det.box.height) * prep.ratio + prep.padY;

    const scaleX = maskW / prep.size;
    const scaleY = maskH / prep.size;
    const mx1 = Math.max(0, Math.floor(lbx1 * scaleX));
    const my1 = Math.max(0, Math.floor(lby1 * scaleY));
    const mx2 = Math.min(maskW, Math.ceil(lbx2 * scaleX));
    const my2 = Math.min(maskH, Math.ceil(lby2 * scaleY));

    const imageData = new ImageData(imgW, imgH);
    const pixels = imageData.data;

    for (let iy = 0; iy < imgH; iy++) {
      const mfy = (iy * prep.ratio + prep.padY) * scaleY;
      const miy = Math.floor(mfy);
      if (miy < my1 || miy >= my2) continue;

      for (let ix = 0; ix < imgW; ix++) {
        const mfx = (ix * prep.ratio + prep.padX) * scaleX;
        const mix = Math.floor(mfx);
        if (mix < mx1 || mix >= mx2) continue;

        const val = combined[miy * maskW + mix];
        if (val > 0.5) {
          const idx = (iy * imgW + ix) * 4;
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        }
      }
    }

    masks.push(imageData);
  }

  return masks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectBubbles(image: HTMLImageElement): Promise<BubbleDetectResult> {
  const { output0, output0Shape, output1, output1Shape, prep } = await runBubbleInference(image);
  const imgW = image.naturalWidth;
  const imgH = image.naturalHeight;

  const detections = decodeDetections(output0, output0Shape, prep, imgW, imgH);
  const masks = decodeMasks(detections, output1, output1Shape, prep, imgW, imgH);

  const bubbles: BubbleDetection[] = detections.map((det, i) => ({
    box: det.box,
    score: det.score,
    mask: masks[i],
  }));

  return { bubbles };
}

// ---------------------------------------------------------------------------
// Region ↔ Bubble matching
// ---------------------------------------------------------------------------

export function matchRegionsToBubbles(
  regions: TextRegion[],
  bubbles: BubbleDetection[],
): { unmatchedCount: number; unmatchedRegionIds: string[] } {
  const unmatchedRegionIds: string[] = [];

  for (const region of regions) {
    const cx = region.box.x + region.box.width / 2;
    const cy = region.box.y + region.box.height / 2;

    let bestBubble: BubbleDetection | null = null;
    let bestArea = Infinity;

    for (const bubble of bubbles) {
      const area = bubble.box.width * bubble.box.height;
      if (area >= bestArea) continue;

      const px = Math.round(cx);
      const py = Math.round(cy);
      const maskW = bubble.mask.width;
      const maskH = bubble.mask.height;
      if (px < 0 || px >= maskW || py < 0 || py >= maskH) continue;

      const idx = (py * maskW + px) * 4;
      if (bubble.mask.data[idx + 3] > 0) {
        bestBubble = bubble;
        bestArea = area;
      }
    }

    if (bestBubble) {
      region.bubbleBox = { ...bestBubble.box };
    } else {
      unmatchedRegionIds.push(region.id);
    }
  }

  return {
    unmatchedCount: unmatchedRegionIds.length,
    unmatchedRegionIds,
  };
}
