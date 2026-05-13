import * as ort from "onnxruntime-web/all";
import type { OcrRunDebugChunk } from "../../types";
import { normalizeTextLight } from "../utils";

// --- Constants ---
export const OCR_AR_PAD = 0;
export const OCR_AR_START = 1;
export const OCR_AR_END = 2;
export const OCR_AR_PAD_BIGINT = BigInt(OCR_AR_PAD);
export const OCR_AR_START_BIGINT = BigInt(OCR_AR_START);
export const OCR_BEAM_WIDTH = 1;
export const OCR_MIN_FINISHED_BEAMS = 2;
export const OCR_CONFIDENCE_THRESHOLD = 0.2;
export const OCR_DECODE_BATCH_SIZE = 24;

// --- Types ---
export type OcrHypothesis = {
  tokenIds: number[];
  tokenProbs: number[];
  finished: boolean;
};

export type OcrDecodeResult = {
  text: string;
  confidence: number;
  tokenIds: number[];
};

// --- Charset ---
let charsetPromise: Promise<string[] | null> | null = null;

export async function loadCharset(dictUrl?: string): Promise<string[] | null> {
  if (!dictUrl) {
    return null;
  }
  if (charsetPromise) {
    return charsetPromise;
  }
  charsetPromise = (async () => {
    const response = await fetch(dictUrl, { method: "GET" });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const lines = text
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : null;
  })();
  return charsetPromise;
}

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
    if (value.dims.length === 3 && value.dims[0] === batchN && value.data instanceof Float32Array) {
      const classes = value.dims[2];
      if (classes > 10) {
        return value;
      }
    }
  }
  return null;
}

// --- Token-to-text ---
export function tokenToTextAutoregressive(token: number, charset: string[] | null): string {
  if (!charset) {
    return "";
  }
  if (token < 0 || token >= charset.length) {
    return "";
  }
  const tokenText = charset[token];
  if (tokenText === "<S>" || tokenText === "</S>") {
    return "";
  }
  if (tokenText === "<SP>") {
    return " ";
  }
  return tokenText;
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

export function findInputName(inputNames: readonly string[], expected: string): string | null {
  const lower = expected.toLowerCase();
  for (const name of inputNames) {
    if (name.toLowerCase() === lower) {
      return name;
    }
  }
  for (const name of inputNames) {
    if (name.toLowerCase().includes(lower)) {
      return name;
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

export function avgLogProbToConfidence(probs: number[]): number {
  if (probs.length === 0) {
    return 0;
  }
  const sumLog = probs.reduce((acc, p) => acc + Math.log(Math.max(1e-6, p)), 0);
  return Math.exp(sumLog / probs.length);
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

      const logitsTensor = pickOcrLogits(outputs);
      if (!logitsTensor) {
        expanded.push({ ...hypothesis, finished: true });
        continue;
      }

      const raw = logitsTensor.data;
      const dims = logitsTensor.dims;
      if (!(raw instanceof Float32Array) || dims.length !== 3 || dims[0] !== 1 || dims[2] <= 0) {
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

// --- Batch types ---
export type BatchDecodeInput = {
  regionId: string;
  inputData: OcrInputData;
  validEncoderLength: number;
};

export type BatchDecodeOutput = {
  text: string;
  confidence: number;
  tokenIds: number[];
  inputData: OcrInputData;
  validEncoderLength: number;
};

// --- Import types from preprocess ---
import type { OcrInputData } from "./preprocess";
import { buildBatchImageTensor } from "./preprocess";

/**
 * Run greedy AR decode for multiple regions in lockstep.
 * Uses a fixed-size batch and reuses decode buffers across steps to reduce CPU churn.
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
  },
  chunkDebug?: OcrRunDebugChunk
): Promise<BatchDecodeOutput[]> {
  const { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput } = inputNames;
  const { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth } = options;
  const N = items.length;
  if (N === 0) {
    return [];
  }

  const regionTokenIds: number[][] = items.map(() => [OCR_AR_START]);
  const regionTokenProbs: number[][] = items.map(() => []);
  const finished: boolean[] = items.map(() => false);
  const batchImage = buildBatchImageTensor(items.map((item) => item.inputData), inputHeight, inputWidth);
  const batchCharData = new BigInt64Array(N * seqLen);
  batchCharData.fill(OCR_AR_PAD_BIGINT);
  const batchDecoderMask = new Array<boolean>(N * seqLen).fill(true);
  const batchEncoderMask = new Array<boolean>(N * encoderLen).fill(false);

  for (let n = 0; n < N; n += 1) {
    const charOffset = n * seqLen;
    batchCharData[charOffset] = OCR_AR_START_BIGINT;
    batchDecoderMask[charOffset] = false;

    const emOffset = n * encoderLen;
    const validEncoderLength = items[n].validEncoderLength;
    for (let i = validEncoderLength; i < encoderLen; i += 1) {
      batchEncoderMask[emOffset + i] = true;
    }
  }

  for (let step = 0; step < maxSteps; step += 1) {
    let activeCount = 0;
    for (let i = 0; i < N; i += 1) {
      if (!finished[i]) {
        activeCount += 1;
      }
    }
    if (activeCount === 0) {
      break;
    }

    const runT0 = performance.now();
    const outputs = await session.run({
      [imageInput]: batchImage,
      [charIdxInput]: new ort.Tensor("int64", batchCharData, [N, seqLen]),
      [decoderMaskInput]: new ort.Tensor("bool", batchDecoderMask, [N, seqLen]),
      [encoderMaskInput]: new ort.Tensor("bool", batchEncoderMask, [N, encoderLen])
    });
    const runDurationMs = performance.now() - runT0;
    if (chunkDebug) {
      chunkDebug.decodeSessionRunCount += 1;
      chunkDebug.decodeSessionRunTotalMs += runDurationMs;
      chunkDebug.decodeSteps.push({
        step,
        activeCount,
        durationMs: runDurationMs
      });
    }

    const logitsTensor = pickBatchOcrLogits(outputs, N);
    if (!logitsTensor) {
      for (let i = 0; i < N; i += 1) {
        if (!finished[i]) {
          finished[i] = true;
        }
      }
      break;
    }

    const raw = logitsTensor.data as Float32Array;
    const dims = logitsTensor.dims;
    const stepsPerSample = dims[1];
    const classes = dims[2];
    const sampleStride = stepsPerSample * classes;

    for (let idx = 0; idx < N; idx += 1) {
      if (finished[idx]) {
        continue;
      }
      const tokens = regionTokenIds[idx];
      if (tokens.length >= seqLen) {
        finished[idx] = true;
        continue;
      }
      const decodeStep = Math.min(tokens.length - 1, Math.max(0, stepsPerSample - 1));
      const sampleOffset = idx * sampleStride;
      const stepOffset = sampleOffset + decodeStep * classes;

      let bestToken = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let c = 0; c < classes; c += 1) {
        const score = raw[stepOffset + c];
        if (score > bestScore) {
          bestScore = score;
          bestToken = c;
        }
      }

      if (bestToken === OCR_AR_PAD || bestToken === OCR_AR_END) {
        finished[idx] = true;
        continue;
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
      const prob = sumExp > 0 ? Math.exp(raw[stepOffset + bestToken] - maxLogit) / sumExp : 0;

      const nextPos = tokens.length;
      const charOffset = idx * seqLen;
      batchCharData[charOffset + nextPos] = BigInt(bestToken);
      batchDecoderMask[charOffset + nextPos] = false;
      tokens.push(bestToken);
      regionTokenProbs[idx].push(prob);
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
      validEncoderLength: items[i].validEncoderLength
    });
  }
  return results;
}