import type { BubbleMask, Rect, TextRegion } from "../types";
import type { PlatformProvider, PipelineImage } from "../runtime/platform";
import { hasBubbleMaskPixel } from "./bubbleMask";
import { nmsBoxes, type ScoredBox } from "./utils";
import { runInference } from "../runtime/onnxBridge";
import type { WorkerSessionHandle, TensorTransport } from "../runtime/onnxWorkerTypes";
import type { WebNnDeviceType } from "../runtime/onnxTypes";
import type {
  ProviderExecutionReport,
  ProviderRuntime,
} from "@shinobu/image-pipeline";
import {
  ProviderPostProcessingError,
  type ProviderSessionResolver,
} from "../runtime/providerExecution";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BubbleDetection = {
  box: Rect;
  score: number;
  mask: BubbleMask;
};

export type BubbleDetectResult = {
  bubbles: BubbleDetection[];
  actualProvider: ProviderRuntime;
  actualWebnnDeviceType?: WebNnDeviceType;
  providerReports: ProviderExecutionReport[];
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

function preprocessLetterbox(image: PipelineImage, size: number, platform: PlatformProvider): LetterboxResult {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const ratio = Math.min(size / w, size / h);
  const newW = Math.round(w * ratio);
  const newH = Math.round(h * ratio);
  const padX = Math.round((size - newW) / 2);
  const padY = Math.round((size - newH) / 2);

  const canvas = platform.createCanvas(size, size);
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

async function runBubbleInference(
  handle: WorkerSessionHandle,
  image: PipelineImage,
  platform: PlatformProvider,
): Promise<{
  output0: Float32Array;
  output0Shape: readonly number[];
  output1: Float32Array;
  output1Shape: readonly number[];
  prep: LetterboxResult;
  actualWebnnDeviceType?: WebNnDeviceType;
}> {
  const size = 640;
  const prep = preprocessLetterbox(image, size, platform);

  const inputName = handle.inputNames[0] ?? "images";
  const feeds: Record<string, TensorTransport> = {
    [inputName]: { data: prep.input, dims: [1, 3, size, size], type: "float32" }
  };
  const result = await runInference(handle.sessionId, feeds);
  if (result.error) throw new Error(result.error);

  const outputNames = handle.outputNames;
  const out0 = result.outputs[outputNames[0]];
  const out1 = result.outputs[outputNames[1]];
  if (!out0 || !out1) {
    throw new Error("气泡检测模型输出张量缺失");
  }

  return {
    output0: out0.data as Float32Array,
    output0Shape: out0.dims,
    output1: out1.data as Float32Array,
    output1Shape: out1.dims,
    prep,
    actualWebnnDeviceType: handle.webnnDeviceType,
  };
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
    maskCoeffs: coeffsMap.get(d.index!)!,
  }));
}

// ---------------------------------------------------------------------------
// Decode proto masks → cropped, single-channel masks
// ---------------------------------------------------------------------------

export function decodeBubbleMasks(
  detections: RawDetection[],
  output1: Float32Array,
  output1Shape: readonly number[],
  prep: LetterboxResult,
  imgW: number,
  imgH: number,
): BubbleMask[] {
  const numProtos = output1Shape[1];
  const maskH = output1Shape[2];
  const maskW = output1Shape[3];

  const masks: BubbleMask[] = [];

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

    // Project the cropped proto-mask range back into source-image coordinates.
    // Proto cells are coarse, so their effective source pixels may extend past
    // the fractional detection box. Scan that complete support and trim only
    // after thresholding to preserve the old full-image mask semantics.
    const projectedX1 = (mx1 / scaleX - prep.padX) / prep.ratio;
    const projectedY1 = (my1 / scaleY - prep.padY) / prep.ratio;
    const projectedX2 = (mx2 / scaleX - prep.padX) / prep.ratio;
    const projectedY2 = (my2 / scaleY - prep.padY) / prep.ratio;
    const scanX1 = Math.max(0, Math.floor(projectedX1) - 1);
    const scanY1 = Math.max(0, Math.floor(projectedY1) - 1);
    const scanX2 = Math.min(imgW, Math.ceil(projectedX2) + 1);
    const scanY2 = Math.min(imgH, Math.ceil(projectedY2) + 1);
    const scanWidth = Math.max(0, scanX2 - scanX1);
    const scanHeight = Math.max(0, scanY2 - scanY1);
    const sampledPixels = new Uint8Array(scanWidth * scanHeight);
    let nonzeroX1 = scanX2;
    let nonzeroY1 = scanY2;
    let nonzeroX2 = scanX1;
    let nonzeroY2 = scanY1;

    for (let iy = scanY1; iy < scanY2; iy++) {
      const mfy = (iy * prep.ratio + prep.padY) * scaleY;
      const miy = Math.floor(mfy);
      if (miy < my1 || miy >= my2) continue;

      for (let ix = scanX1; ix < scanX2; ix++) {
        const mfx = (ix * prep.ratio + prep.padX) * scaleX;
        const mix = Math.floor(mfx);
        if (mix < mx1 || mix >= mx2) continue;

        const val = combined[miy * maskW + mix];
        if (val > 0.5) {
          sampledPixels[(iy - scanY1) * scanWidth + (ix - scanX1)] = 1;
          nonzeroX1 = Math.min(nonzeroX1, ix);
          nonzeroY1 = Math.min(nonzeroY1, iy);
          nonzeroX2 = Math.max(nonzeroX2, ix + 1);
          nonzeroY2 = Math.max(nonzeroY2, iy + 1);
        }
      }
    }

    if (nonzeroX2 <= nonzeroX1 || nonzeroY2 <= nonzeroY1) {
      masks.push({
        x: scanX1,
        y: scanY1,
        width: 0,
        height: 0,
        data: new Uint8Array(),
      });
      continue;
    }

    const width = nonzeroX2 - nonzeroX1;
    const height = nonzeroY2 - nonzeroY1;
    const pixels = new Uint8Array(width * height);
    const localX1 = nonzeroX1 - scanX1;
    for (let row = 0; row < height; row++) {
      const sourceStart = (nonzeroY1 - scanY1 + row) * scanWidth + localX1;
      pixels.set(sampledPixels.subarray(sourceStart, sourceStart + width), row * width);
    }

    masks.push({
      x: nonzeroX1,
      y: nonzeroY1,
      width,
      height,
      data: pixels,
    });
  }

  return masks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectBubbles(
  image: PipelineImage,
  platform: PlatformProvider,
  resolver: ProviderSessionResolver,
): Promise<BubbleDetectResult> {
  const execution = await resolver.execute({
    model: "bubble",
    stage: "bubble",
    run: (handle) => runBubbleInference(handle, image, platform),
  });
  const {
    output0,
    output0Shape,
    output1,
    output1Shape,
    prep,
    actualWebnnDeviceType,
  } = execution.value;
  const actualProvider = execution.report.finalProvider!;
  const providerReports = [execution.report];

  try {
    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const detections = decodeDetections(output0, output0Shape, prep, imgW, imgH);
    const masks = decodeBubbleMasks(detections, output1, output1Shape, prep, imgW, imgH);
    const bubbles: BubbleDetection[] = detections.map((det, i) => ({
      box: det.box,
      score: det.score,
      mask: masks[i],
    }));

    return {
      bubbles,
      actualProvider,
      actualWebnnDeviceType,
      providerReports,
    };
  } catch (error) {
    throw new ProviderPostProcessingError(error, providerReports);
  }
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

      if (hasBubbleMaskPixel(bubble.mask, Math.round(cx), Math.round(cy))) {
        bestBubble = bubble;
        bestArea = area;
      }
    }

    if (bestBubble) {
      region.bubbleBox = { ...bestBubble.box };
      region.bubbleMask = bestBubble.mask;
    } else {
      unmatchedRegionIds.push(region.id);
    }
  }

  return {
    unmatchedCount: unmatchedRegionIds.length,
    unmatchedRegionIds,
  };
}
