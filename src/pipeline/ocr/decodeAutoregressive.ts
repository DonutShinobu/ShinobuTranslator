import * as ort from "onnxruntime-web/all";
import type { OcrRunDebugChunk, OcrRunDebugStep } from "../../types";
import { normalizeTextLight } from "../utils";
import { extractColorsFromOutputs } from "./colorDecodeShared";
import type { OcrColorResult } from "./colorDecodeShared";
import { OcrGpuStepReducer } from "./gpuArgmax";
import type { OcrGpuStepResult } from "./gpuArgmax";
import {
  OCR_AR_PAD,
  OCR_AR_START,
  OCR_AR_END,
  OCR_AR_PAD_BIGINT,
  OCR_BEAM_WIDTH,
  OCR_MIN_FINISHED_BEAMS,
  type OcrHypothesis,
  type OcrDecodeResult,
  type BatchDecodeInput,
  type BatchDecodeOutput,
  tokenToTextAutoregressive,
  avgLogProbToConfidence,
} from "./ocrShared";

export type OcrEncoderCacheInputNames = {
  encoderImageInput: string;
  encoderMaskInput: string;
  memoryOutput: string;
  decoderMemoryInput: string;
  decoderCharIdxInput: string;
  decoderMaskInput: string;
  decoderEncoderMaskInput: string;
};

// --- Re-export shared constants for backward compat ---
export {
  OCR_AR_PAD,
  OCR_AR_START,
  OCR_AR_END,
  OCR_AR_PAD_BIGINT,
  OCR_AR_START_BIGINT,
  OCR_BEAM_WIDTH,
  OCR_MIN_FINISHED_BEAMS,
  OCR_CONFIDENCE_THRESHOLD,
  OCR_DECODE_BATCH_SIZE,
  loadCharset,
  findInputName,
  tokenToTextAutoregressive,
  avgLogProbToConfidence,
} from "./ocrShared";

// --- Tensor picking ---
export function pickOcrLogits(outputs: ort.InferenceSession.ReturnType): ort.Tensor | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[0] === 1) {
      return value;
    }
  }
  return null;
}

export function pickBatchOcrLogits(outputs: ort.InferenceSession.ReturnType, batchN: number): ort.Tensor | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[0] === batchN && value.type === "float32") {
      const classes = value.dims[2];
      if (classes > 10) {
        return value;
      }
    }
  }
  return null;
}

// --- Output/input name helpers ---
export function getOutputByName(outputs: ort.InferenceSession.ReturnType, preferred: string, rank: number): ort.Tensor | null {
  for (const [name, value] of Object.entries(outputs)) {
    if (name.toLowerCase() === preferred.toLowerCase() && value.dims.length === rank) {
      return value;
    }
  }
  for (const [name, value] of Object.entries(outputs)) {
    if (name.toLowerCase().includes(preferred.toLowerCase()) && value.dims.length === rank) {
      return value;
    }
  }
  return null;
}

export function getInputDim(session: ort.InferenceSession, inputName: string, axis: number, fallback: number): number {
  const idx = session.inputNames.indexOf(inputName);
  if (idx < 0) {
    return fallback;
  }
  const metadata = session.inputMetadata[idx];
  const dim = metadata?.isTensor ? metadata.shape[axis] : undefined;
  if (typeof dim === "number" && dim > 0) {
    return dim;
  }
  return fallback;
}

async function readFloat32TensorData(tensor: ort.Tensor): Promise<Float32Array | null> {
  try {
    if (tensor.data instanceof Float32Array) {
      return tensor.data;
    }
  } catch {
    // GPU-backed tensors throw when `data` is accessed. Fall through to getData().
  }
  try {
    const data = await tensor.getData();
    return data instanceof Float32Array ? data : null;
  } catch {
    return null;
  }
}

function disposeOutputs(outputs: ort.InferenceSession.ReturnType): void {
  for (const tensor of Object.values(outputs)) {
    tensor.dispose();
  }
}

// --- Beam search helpers ---
function topKAt(logits: Float32Array, classes: number, step: number, topK: number): number[] {
  const limit = Math.max(1, Math.min(topK, classes));
  const bestIds = new Array<number>(limit).fill(0);
  const bestScores = new Array<number>(limit).fill(Number.NEGATIVE_INFINITY);
  const base = step * classes;
  for (let i = 0; i < classes; i += 1) {
    const score = logits[base + i];
    if (score <= bestScores[limit - 1]) {
      continue;
    }
    let insert = limit - 1;
    while (insert > 0 && score > bestScores[insert - 1]) {
      bestScores[insert] = bestScores[insert - 1];
      bestIds[insert] = bestIds[insert - 1];
      insert -= 1;
    }
    bestScores[insert] = score;
    bestIds[insert] = i;
  }
  return bestIds;
}

function probAt(logits: Float32Array, classes: number, step: number, token: number): number {
  const base = step * classes;
  let maxLogit = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < classes; i += 1) {
    const score = logits[base + i];
    if (score > maxLogit) {
      maxLogit = score;
    }
  }
  let sumExp = 0;
  for (let i = 0; i < classes; i += 1) {
    sumExp += Math.exp(logits[base + i] - maxLogit);
  }
  if (sumExp <= 0) {
    return 0;
  }
  return Math.exp(logits[base + token] - maxLogit) / sumExp;
}

function avgLogProb(probs: number[]): number {
  if (probs.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return probs.reduce((acc, p) => acc + Math.log(Math.max(1e-6, p)), 0) / probs.length;
}

// --- Single-region beam decode ---
export async function decodeAutoregressiveWithBeam(
  session: ort.InferenceSession,
  inputs: {
    imageInput: string;
    imageTensor: ort.Tensor;
    charIdxInput: string;
    decoderMaskInput: string;
    encoderMaskInput: string;
  },
  options: {
    seqLen: number;
    encoderLen: number;
    validEncoderLength: number;
    maxSteps: number;
    charset: string[] | null;
  },
  chunkDebug?: OcrRunDebugChunk
): Promise<OcrDecodeResult | null> {
  const { imageInput, imageTensor, charIdxInput, decoderMaskInput, encoderMaskInput } = inputs;
  const { seqLen, encoderLen, validEncoderLength, maxSteps, charset } = options;

  const encoderMask = new Array<boolean>(encoderLen).fill(false);
  for (let i = validEncoderLength; i < encoderLen; i += 1) {
    encoderMask[i] = true;
  }

  let hypotheses: OcrHypothesis[] = [{ tokenIds: [OCR_AR_START], tokenProbs: [], finished: false }];

  for (let step = 0; step < maxSteps; step += 1) {
    const expanded: OcrHypothesis[] = [];

    for (const hypothesis of hypotheses) {
      if (hypothesis.finished) {
        expanded.push(hypothesis);
        continue;
      }

      const charData = new BigInt64Array(seqLen);
      for (let i = 0; i < seqLen; i += 1) {
        charData[i] = OCR_AR_PAD_BIGINT;
      }
      for (let i = 0; i < hypothesis.tokenIds.length && i < seqLen; i += 1) {
        charData[i] = BigInt(hypothesis.tokenIds[i]);
      }

      const decoderMask = new Array<boolean>(seqLen).fill(true);
      for (let i = 0; i < hypothesis.tokenIds.length && i < seqLen; i += 1) {
        decoderMask[i] = false;
      }

      const runT0 = performance.now();
      const outputs = await session.run({
        [imageInput]: imageTensor,
        [charIdxInput]: new ort.Tensor("int64", charData, [1, seqLen]),
        [decoderMaskInput]: new ort.Tensor("bool", decoderMask, [1, seqLen]),
        [encoderMaskInput]: new ort.Tensor("bool", encoderMask, [1, encoderLen])
      });
      const runDurationMs = performance.now() - runT0;
      if (chunkDebug) {
        chunkDebug.decodeSessionRunCount += 1;
        chunkDebug.decodeSessionRunTotalMs += runDurationMs;
      }
      try {
        const logitsTensor = pickOcrLogits(outputs);
        if (!logitsTensor) {
          expanded.push({ ...hypothesis, finished: true });
          continue;
        }

        const raw = await readFloat32TensorData(logitsTensor);
        const dims = logitsTensor.dims;
        if (!raw || dims.length !== 3 || dims[0] !== 1 || dims[2] <= 0) {
          expanded.push({ ...hypothesis, finished: true });
          continue;
        }

        const classes = dims[2];
        const decodeStep = Math.min(hypothesis.tokenIds.length - 1, Math.max(0, dims[1] - 1));
        const nextTokens = topKAt(raw, classes, decodeStep, OCR_BEAM_WIDTH);
        let produced = false;

        for (const nextToken of nextTokens) {
          if (nextToken === OCR_AR_PAD) {
            continue;
          }
          produced = true;
          if (nextToken === OCR_AR_END) {
            expanded.push({ ...hypothesis, finished: true });
            continue;
          }
          expanded.push({
            tokenIds: [...hypothesis.tokenIds, nextToken],
            tokenProbs: [...hypothesis.tokenProbs, probAt(raw, classes, decodeStep, nextToken)],
            finished: false
          });
        }

        if (!produced) {
          expanded.push({ ...hypothesis, finished: true });
        }
      } finally {
        disposeOutputs(outputs);
      }
    }

    if (expanded.length === 0) {
      break;
    }

    hypotheses = expanded
      .sort((a, b) => avgLogProb(b.tokenProbs) - avgLogProb(a.tokenProbs))
      .slice(0, OCR_BEAM_WIDTH);

    const finishedCount = hypotheses.reduce((acc, hypothesis) => (hypothesis.finished ? acc + 1 : acc), 0);
    if (finishedCount >= OCR_MIN_FINISHED_BEAMS || finishedCount === hypotheses.length) {
      break;
    }
  }

  let best: OcrDecodeResult | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const hypothesis of hypotheses) {
    const decoded = normalizeTextLight(hypothesis.tokenIds.slice(1).map((id) => tokenToTextAutoregressive(id, charset)).join(""));
    if (decoded.length === 0) {
      continue;
    }
    const score = avgLogProb(hypothesis.tokenProbs);
    if (score > bestScore) {
      bestScore = score;
      best = {
        text: decoded,
        confidence: avgLogProbToConfidence(hypothesis.tokenProbs),
        tokenIds: hypothesis.tokenIds.slice(1)
      };
    }
  }

  return best;
}

function buildActiveBatchFeeds(
  items: BatchDecodeInput[],
  activeIndices: readonly number[],
  regionTokenIds: number[][],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number
): {
  imageTensor: ort.Tensor;
  charTensor: ort.Tensor;
  decoderMaskTensor: ort.Tensor;
  encoderMaskTensor: ort.Tensor;
} {
  const activeN = activeIndices.length;
  const pixelsPerImage = 3 * inputHeight * inputWidth;
  const imageData = new Float32Array(activeN * pixelsPerImage);
  const charData = new BigInt64Array(activeN * seqLen);
  charData.fill(OCR_AR_PAD_BIGINT);
  const decoderMask = new Array<boolean>(activeN * seqLen).fill(true);
  const encoderMask = new Array<boolean>(activeN * encoderLen).fill(false);

  for (let local = 0; local < activeN; local += 1) {
    const sourceIndex = activeIndices[local];
    imageData.set(items[sourceIndex].inputData.data, local * pixelsPerImage);

    const tokens = regionTokenIds[sourceIndex];
    const charOffset = local * seqLen;
    for (let pos = 0; pos < tokens.length && pos < seqLen; pos += 1) {
      charData[charOffset + pos] = BigInt(tokens[pos]);
      decoderMask[charOffset + pos] = false;
    }

    const encoderOffset = local * encoderLen;
    const validEncoderLength = items[sourceIndex].validEncoderLength;
    for (let pos = validEncoderLength; pos < encoderLen; pos += 1) {
      encoderMask[encoderOffset + pos] = true;
    }
  }

  return {
    imageTensor: new ort.Tensor("float32", imageData, [activeN, 3, inputHeight, inputWidth]),
    charTensor: new ort.Tensor("int64", charData, [activeN, seqLen]),
    decoderMaskTensor: new ort.Tensor("bool", decoderMask, [activeN, seqLen]),
    encoderMaskTensor: new ort.Tensor("bool", encoderMask, [activeN, encoderLen])
  };
}

function extractBatchColorsFromOutputs(
  outputs: ort.InferenceSession.ReturnType,
  batchN: number,
  sampleIndex: number,
  tokenCount: number
): OcrColorResult | null {
  if (tokenCount <= 0) {
    return null;
  }
  const fg = getOutputByName(outputs, "fg", 3);
  const bg = getOutputByName(outputs, "bg", 3);
  const fgInd = getOutputByName(outputs, "fg_ind", 3);
  const bgInd = getOutputByName(outputs, "bg_ind", 3);
  if (!fg || !bg || !fgInd || !bgInd) {
    return null;
  }
  if (fg.dims[0] !== batchN || bg.dims[0] !== batchN || fgInd.dims[0] !== batchN || bgInd.dims[0] !== batchN) {
    return null;
  }
  if (!(fg.data instanceof Float32Array) || !(bg.data instanceof Float32Array) || !(fgInd.data instanceof Float32Array) || !(bgInd.data instanceof Float32Array)) {
    return null;
  }
  const stepsPerSample = Math.min(fg.dims[1] ?? 0, bg.dims[1] ?? 0, fgInd.dims[1] ?? 0, bgInd.dims[1] ?? 0);
  return extractColorsFromOutputs(
    fg.data,
    bg.data,
    fgInd.data,
    bgInd.data,
    stepsPerSample,
    sampleIndex * stepsPerSample,
    tokenCount
  );
}

function copyActiveMemoryTensor(
  memoryData: Float32Array,
  memoryDims: readonly number[],
  activeIndices: readonly number[]
): ort.Tensor {
  const encoderLen = memoryDims[1];
  const memoryWidth = memoryDims[2];
  const valuesPerSample = encoderLen * memoryWidth;
  const activeData = new Float32Array(activeIndices.length * valuesPerSample);
  for (let local = 0; local < activeIndices.length; local += 1) {
    const sourceOffset = activeIndices[local] * valuesPerSample;
    activeData.set(memoryData.subarray(sourceOffset, sourceOffset + valuesPerSample), local * valuesPerSample);
  }
  return new ort.Tensor("float32", activeData, [activeIndices.length, encoderLen, memoryWidth]);
}

function buildActiveDecoderFeeds(
  items: BatchDecodeInput[],
  activeIndices: readonly number[],
  regionTokenIds: number[][],
  cachedMemory: { data: Float32Array; dims: readonly number[] },
  seqLen: number,
  encoderLen: number
): {
  memoryTensor: ort.Tensor;
  charTensor: ort.Tensor;
  decoderMaskTensor: ort.Tensor;
  encoderMaskTensor: ort.Tensor;
} {
  const activeN = activeIndices.length;
  const charData = new BigInt64Array(activeN * seqLen);
  charData.fill(OCR_AR_PAD_BIGINT);
  const decoderMask = new Array<boolean>(activeN * seqLen).fill(true);
  const encoderMask = new Array<boolean>(activeN * encoderLen).fill(false);

  for (let local = 0; local < activeN; local += 1) {
    const sourceIndex = activeIndices[local];
    const tokens = regionTokenIds[sourceIndex];
    const charOffset = local * seqLen;
    for (let pos = 0; pos < tokens.length && pos < seqLen; pos += 1) {
      charData[charOffset + pos] = BigInt(tokens[pos]);
      decoderMask[charOffset + pos] = false;
    }

    const encoderOffset = local * encoderLen;
    const validEncoderLength = items[sourceIndex].validEncoderLength;
    for (let pos = validEncoderLength; pos < encoderLen; pos += 1) {
      encoderMask[encoderOffset + pos] = true;
    }
  }

  return {
    memoryTensor: copyActiveMemoryTensor(cachedMemory.data, cachedMemory.dims, activeIndices),
    charTensor: new ort.Tensor("int64", charData, [activeN, seqLen]),
    decoderMaskTensor: new ort.Tensor("bool", decoderMask, [activeN, seqLen]),
    encoderMaskTensor: new ort.Tensor("bool", encoderMask, [activeN, encoderLen])
  };
}

/**
 * Run greedy AR decode for multiple regions in lockstep.
 * Uses active batch compaction so finished regions stop consuming model compute.
 * Only works correctly when OCR_BEAM_WIDTH === 1 (greedy).
 */
export async function decodeBatchAutoregressive(
  session: ort.InferenceSession,
  inputNames: {
    imageInput: string;
    charIdxInput: string;
    decoderMaskInput: string;
    encoderMaskInput: string;
  },
  items: BatchDecodeInput[],
  options: {
    seqLen: number;
    encoderLen: number;
    maxSteps: number;
    charset: string[] | null;
    inputHeight: number;
    inputWidth: number;
    gpuArgmaxDevice?: GPUDevice;
    compactActiveBatch?: boolean;
  },
  chunkDebug?: OcrRunDebugChunk
): Promise<BatchDecodeOutput[]> {
  const { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput } = inputNames;
  const { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth, gpuArgmaxDevice, compactActiveBatch = true } = options;
  const N = items.length;
  if (N === 0) {
    return [];
  }
  const allIndices = items.map((_, index) => index);

  const regionTokenIds: number[][] = items.map(() => [OCR_AR_START]);
  const regionTokenProbs: number[][] = items.map(() => []);
  const finished: boolean[] = items.map(() => false);
  const latestColors: Array<OcrColorResult | null> = items.map(() => null);
  const latestColorTokenCounts: number[] = items.map(() => 0);
  let gpuStepReducer: OcrGpuStepReducer | null = gpuArgmaxDevice ? new OcrGpuStepReducer(gpuArgmaxDevice) : null;

  for (let step = 0; step < maxSteps; step += 1) {
    const activeIndices: number[] = [];
    for (let i = 0; i < N; i += 1) {
      if (finished[i]) {
        continue;
      }
      if (regionTokenIds[i].length >= seqLen) {
        finished[i] = true;
        continue;
      }
      activeIndices.push(i);
    }
    const activeCount = activeIndices.length;
    if (activeCount === 0) {
      break;
    }

    const runSessionForIndices = async (sourceIndices: readonly number[]) => {
      const feeds = buildActiveBatchFeeds(
        items,
        sourceIndices,
        regionTokenIds,
        seqLen,
        encoderLen,
        inputHeight,
        inputWidth
      );
      return session.run({
        [imageInput]: feeds.imageTensor,
        [charIdxInput]: feeds.charTensor,
        [decoderMaskInput]: feeds.decoderMaskTensor,
        [encoderMaskInput]: feeds.encoderMaskTensor
      });
    };

    let runIndices = compactActiveBatch ? activeIndices : allIndices;
    let compactFallback = false;
    const runT0 = performance.now();
    let outputs: ort.InferenceSession.ReturnType;
    try {
      outputs = await runSessionForIndices(runIndices);
    } catch (error) {
      if (!compactActiveBatch || activeCount === N) {
        throw error;
      }
      compactFallback = true;
      runIndices = allIndices;
      outputs = await runSessionForIndices(runIndices);
    }
    const runDurationMs = performance.now() - runT0;
    const runBatchSize = runIndices.length;
    const debugStep: OcrRunDebugStep | null = chunkDebug ? {
      step,
      activeCount,
      batchSize: runBatchSize,
      compactFallback,
      durationMs: runDurationMs,
    } : null;
    if (chunkDebug) {
      chunkDebug.decodeSessionRunCount += 1;
      chunkDebug.decodeSessionRunTotalMs += runDurationMs;
      chunkDebug.decodeSteps.push(debugStep!);
    }
    const postprocessT0 = performance.now();
    let postprocessMode: "cpu" | "gpu" | "gpu-fallback" = "cpu";
    try {
      const logitsTensor = pickBatchOcrLogits(outputs, runBatchSize);
      if (!logitsTensor) {
        for (const sourceIndex of activeIndices) {
          finished[sourceIndex] = true;
        }
        break;
      }

      const dims = logitsTensor.dims;
      const stepsPerSample = dims[1];
      const classes = dims[2];
      const sampleStride = stepsPerSample * classes;
      const commonDecodeStep = Math.min(regionTokenIds[activeIndices[0]].length - 1, Math.max(0, stepsPerSample - 1));
      let gpuStepResults: OcrGpuStepResult[] | null = null;
      let raw: Float32Array | null = null;

      if (gpuStepReducer) {
        try {
          gpuStepResults = await gpuStepReducer.reduce(logitsTensor, runBatchSize, stepsPerSample, classes, commonDecodeStep);
          if (gpuStepResults) {
            postprocessMode = "gpu";
          }
        } catch (error) {
          console.warn(`[ocr] GPU argmax 失败，回退 CPU logits: ${error instanceof Error ? error.message : String(error)}`);
          gpuStepReducer = null;
          postprocessMode = "gpu-fallback";
        }
      }

      if (!gpuStepResults) {
        raw = await readFloat32TensorData(logitsTensor);
        if (!raw) {
          for (const sourceIndex of activeIndices) {
            finished[sourceIndex] = true;
          }
          break;
        }
      }

      for (let local = 0; local < runBatchSize; local += 1) {
        const idx = runIndices[local];
        if (finished[idx]) {
          continue;
        }
        const tokens = regionTokenIds[idx];
        const currentTokenCount = Math.max(0, tokens.length - 1);
        const colors = extractBatchColorsFromOutputs(outputs, runBatchSize, local, currentTokenCount);
        if (colors) {
          latestColors[idx] = colors;
          latestColorTokenCounts[idx] = currentTokenCount;
        }
        if (tokens.length >= seqLen) {
          finished[idx] = true;
          continue;
        }
        const decodeStep = Math.min(tokens.length - 1, Math.max(0, stepsPerSample - 1));

        let bestToken = 0;
        let prob = 0;
        if (gpuStepResults) {
          const gpuResult = gpuStepResults[local];
          bestToken = gpuResult.token;
          prob = gpuResult.probability;
        } else if (raw) {
          const sampleOffset = local * sampleStride;
          const stepOffset = sampleOffset + decodeStep * classes;
          let bestScore = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c += 1) {
            const score = raw[stepOffset + c];
            if (score > bestScore) {
              bestScore = score;
              bestToken = c;
            }
          }

          let maxLogit = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c += 1) {
            const s = raw[stepOffset + c];
            if (s > maxLogit) {
              maxLogit = s;
            }
          }
          let sumExp = 0;
          for (let c = 0; c < classes; c += 1) {
            sumExp += Math.exp(raw[stepOffset + c] - maxLogit);
          }
          prob = sumExp > 0 ? Math.exp(raw[stepOffset + bestToken] - maxLogit) / sumExp : 0;
        }

        if (bestToken === OCR_AR_PAD || bestToken === OCR_AR_END) {
          finished[idx] = true;
          continue;
        }

        tokens.push(bestToken);
        regionTokenProbs[idx].push(prob);
      }
    } finally {
      if (debugStep) {
        debugStep.postprocessMode = postprocessMode;
        debugStep.postprocessMs = performance.now() - postprocessT0;
      }
      disposeOutputs(outputs);
    }
  }

  const results: BatchDecodeOutput[] = [];
  for (let i = 0; i < N; i += 1) {
    const tokenIds = regionTokenIds[i].slice(1); // remove START token
    const text = normalizeTextLight(tokenIds.map((id) => tokenToTextAutoregressive(id, charset)).join(""));
    const confidence = avgLogProbToConfidence(regionTokenProbs[i]);
    results.push({
      text,
      confidence,
      tokenIds,
      inputData: items[i].inputData,
      validEncoderLength: items[i].validEncoderLength,
      colors: latestColorTokenCounts[i] >= tokenIds.length ? latestColors[i] ?? undefined : undefined
    });
  }
  return results;
}

/**
 * Run greedy AR decode using a split OCR encoder/decoder pair.
 * The encoder is executed once per chunk; decoder steps reuse cached memory.
 */
export async function decodeBatchAutoregressiveWithEncoderCache(
  encoderSession: ort.InferenceSession,
  decoderSession: ort.InferenceSession,
  inputNames: OcrEncoderCacheInputNames,
  items: BatchDecodeInput[],
  options: {
    seqLen: number;
    encoderLen: number;
    maxSteps: number;
    charset: string[] | null;
    inputHeight: number;
    inputWidth: number;
    gpuArgmaxDevice?: GPUDevice;
    compactActiveBatch?: boolean;
  },
  chunkDebug?: OcrRunDebugChunk
): Promise<BatchDecodeOutput[]> {
  const {
    encoderImageInput,
    encoderMaskInput,
    memoryOutput,
    decoderMemoryInput,
    decoderCharIdxInput,
    decoderMaskInput,
    decoderEncoderMaskInput,
  } = inputNames;
  const { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth, gpuArgmaxDevice, compactActiveBatch = true } = options;
  const N = items.length;
  if (N === 0) {
    return [];
  }

  const allIndices = items.map((_, index) => index);
  const encoderFeeds = buildActiveBatchFeeds(items, allIndices, items.map(() => [OCR_AR_START]), seqLen, encoderLen, inputHeight, inputWidth);
  const encoderT0 = performance.now();
  const encoderOutputs = await encoderSession.run({
    [encoderImageInput]: encoderFeeds.imageTensor,
    [encoderMaskInput]: encoderFeeds.encoderMaskTensor,
  });
  const encoderRunMs = performance.now() - encoderT0;
  if (chunkDebug) {
    chunkDebug.encoderCache = true;
    chunkDebug.encoderRunMs = (chunkDebug.encoderRunMs ?? 0) + encoderRunMs;
    chunkDebug.decodeSessionRunCount += 1;
    chunkDebug.decodeSessionRunTotalMs += encoderRunMs;
  }

  const memoryTensor = encoderOutputs[memoryOutput] ?? Object.values(encoderOutputs)[0];
  if (!memoryTensor || memoryTensor.dims.length !== 3 || memoryTensor.dims[0] !== N) {
    disposeOutputs(encoderOutputs);
    throw new Error("OCR encoder cache output shape invalid");
  }
  const memoryRaw = await readFloat32TensorData(memoryTensor);
  if (!memoryRaw) {
    disposeOutputs(encoderOutputs);
    throw new Error("OCR encoder cache output is not float32");
  }
  const cachedMemory = {
    data: new Float32Array(memoryRaw),
    dims: [...memoryTensor.dims],
  };
  disposeOutputs(encoderOutputs);

  const regionTokenIds: number[][] = items.map(() => [OCR_AR_START]);
  const regionTokenProbs: number[][] = items.map(() => []);
  const finished: boolean[] = items.map(() => false);
  const latestColors: Array<OcrColorResult | null> = items.map(() => null);
  const latestColorTokenCounts: number[] = items.map(() => 0);
  let gpuStepReducer: OcrGpuStepReducer | null = gpuArgmaxDevice ? new OcrGpuStepReducer(gpuArgmaxDevice) : null;

  for (let step = 0; step < maxSteps; step += 1) {
    const activeIndices: number[] = [];
    for (let i = 0; i < N; i += 1) {
      if (finished[i]) {
        continue;
      }
      if (regionTokenIds[i].length >= seqLen) {
        finished[i] = true;
        continue;
      }
      activeIndices.push(i);
    }
    const activeCount = activeIndices.length;
    if (activeCount === 0) {
      break;
    }

    const runDecoderForIndices = async (sourceIndices: readonly number[]) => {
      const feeds = buildActiveDecoderFeeds(
        items,
        sourceIndices,
        regionTokenIds,
        cachedMemory,
        seqLen,
        encoderLen
      );
      return decoderSession.run({
        [decoderMemoryInput]: feeds.memoryTensor,
        [decoderCharIdxInput]: feeds.charTensor,
        [decoderMaskInput]: feeds.decoderMaskTensor,
        [decoderEncoderMaskInput]: feeds.encoderMaskTensor,
      });
    };

    let runIndices = compactActiveBatch ? activeIndices : allIndices;
    let compactFallback = false;
    const runT0 = performance.now();
    let outputs: ort.InferenceSession.ReturnType;
    try {
      outputs = await runDecoderForIndices(runIndices);
    } catch (error) {
      if (!compactActiveBatch || activeCount === N) {
        throw error;
      }
      compactFallback = true;
      runIndices = allIndices;
      outputs = await runDecoderForIndices(runIndices);
    }
    const runDurationMs = performance.now() - runT0;
    const runBatchSize = runIndices.length;
    const debugStep: OcrRunDebugStep | null = chunkDebug ? {
      step,
      activeCount,
      batchSize: runBatchSize,
      compactFallback,
      durationMs: runDurationMs,
    } : null;
    if (chunkDebug) {
      chunkDebug.decoderRunMs = (chunkDebug.decoderRunMs ?? 0) + runDurationMs;
      chunkDebug.decodeSessionRunCount += 1;
      chunkDebug.decodeSessionRunTotalMs += runDurationMs;
      chunkDebug.decodeSteps.push(debugStep!);
    }

    const postprocessT0 = performance.now();
    let postprocessMode: "cpu" | "gpu" | "gpu-fallback" = "cpu";
    try {
      const logitsTensor = pickBatchOcrLogits(outputs, runBatchSize);
      if (!logitsTensor) {
        for (const sourceIndex of activeIndices) {
          finished[sourceIndex] = true;
        }
        break;
      }

      const dims = logitsTensor.dims;
      const stepsPerSample = dims[1];
      const classes = dims[2];
      const sampleStride = stepsPerSample * classes;
      const commonDecodeStep = Math.min(regionTokenIds[activeIndices[0]].length - 1, Math.max(0, stepsPerSample - 1));
      let gpuStepResults: OcrGpuStepResult[] | null = null;
      let raw: Float32Array | null = null;

      if (gpuStepReducer) {
        try {
          gpuStepResults = await gpuStepReducer.reduce(logitsTensor, runBatchSize, stepsPerSample, classes, commonDecodeStep);
          if (gpuStepResults) {
            postprocessMode = "gpu";
          }
        } catch (error) {
          console.warn(`[ocr] GPU argmax 失败，回退 CPU logits: ${error instanceof Error ? error.message : String(error)}`);
          gpuStepReducer = null;
          postprocessMode = "gpu-fallback";
        }
      }

      if (!gpuStepResults) {
        raw = await readFloat32TensorData(logitsTensor);
        if (!raw) {
          for (const sourceIndex of activeIndices) {
            finished[sourceIndex] = true;
          }
          break;
        }
      }

      for (let local = 0; local < runBatchSize; local += 1) {
        const idx = runIndices[local];
        if (finished[idx]) {
          continue;
        }
        const tokens = regionTokenIds[idx];
        const currentTokenCount = Math.max(0, tokens.length - 1);
        const colors = extractBatchColorsFromOutputs(outputs, runBatchSize, local, currentTokenCount);
        if (colors) {
          latestColors[idx] = colors;
          latestColorTokenCounts[idx] = currentTokenCount;
        }
        if (tokens.length >= seqLen) {
          finished[idx] = true;
          continue;
        }
        const decodeStep = Math.min(tokens.length - 1, Math.max(0, stepsPerSample - 1));

        let bestToken = 0;
        let prob = 0;
        if (gpuStepResults) {
          const gpuResult = gpuStepResults[local];
          bestToken = gpuResult.token;
          prob = gpuResult.probability;
        } else if (raw) {
          const sampleOffset = local * sampleStride;
          const stepOffset = sampleOffset + decodeStep * classes;
          let bestScore = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c += 1) {
            const score = raw[stepOffset + c];
            if (score > bestScore) {
              bestScore = score;
              bestToken = c;
            }
          }

          let maxLogit = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c += 1) {
            const s = raw[stepOffset + c];
            if (s > maxLogit) {
              maxLogit = s;
            }
          }
          let sumExp = 0;
          for (let c = 0; c < classes; c += 1) {
            sumExp += Math.exp(raw[stepOffset + c] - maxLogit);
          }
          prob = sumExp > 0 ? Math.exp(raw[stepOffset + bestToken] - maxLogit) / sumExp : 0;
        }

        if (bestToken === OCR_AR_PAD || bestToken === OCR_AR_END) {
          finished[idx] = true;
          continue;
        }

        tokens.push(bestToken);
        regionTokenProbs[idx].push(prob);
      }
    } finally {
      if (debugStep) {
        debugStep.postprocessMode = postprocessMode;
        debugStep.postprocessMs = performance.now() - postprocessT0;
      }
      disposeOutputs(outputs);
    }
  }

  const results: BatchDecodeOutput[] = [];
  for (let i = 0; i < N; i += 1) {
    const tokenIds = regionTokenIds[i].slice(1);
    const text = normalizeTextLight(tokenIds.map((id) => tokenToTextAutoregressive(id, charset)).join(""));
    const confidence = avgLogProbToConfidence(regionTokenProbs[i]);
    results.push({
      text,
      confidence,
      tokenIds,
      inputData: items[i].inputData,
      validEncoderLength: items[i].validEncoderLength,
      colors: latestColorTokenCounts[i] >= tokenIds.length ? latestColors[i] ?? undefined : undefined
    });
  }
  return results;
}
