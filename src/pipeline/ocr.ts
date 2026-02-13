import * as ort from "onnxruntime-web/all";
import type { TextRegion } from "../types";
import { getModel, getModelSession } from "../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../runtime/onnx";
import type { RuntimeProvider, WebNnDeviceType } from "../runtime/onnx";

export type OcrResult = {
  regions: TextRegion[];
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
};

const OCR_AR_PAD = 0;
const OCR_AR_START = 1;
const OCR_AR_END = 2;
const OCR_AR_PAD_BIGINT = BigInt(OCR_AR_PAD);
const OCR_AR_START_BIGINT = BigInt(OCR_AR_START);
const OCR_BEAM_WIDTH = 1;
const OCR_MIN_FINISHED_BEAMS = 2;
const OCR_CONFIDENCE_THRESHOLD = 0.2;
const OCR_DECODE_BATCH_SIZE = 16;

type Direction = "h" | "v";

type DirectedRegion = {
  region: TextRegion;
  direction: Direction;
};

type OcrHypothesis = {
  tokenIds: number[];
  tokenProbs: number[];
  finished: boolean;
};

type OcrDecodeResult = {
  text: string;
  confidence: number;
  tokenIds: number[];
};

function normalizeText(text: string): string {
  return text.trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

let charsetPromise: Promise<string[] | null> | null = null;

async function loadCharset(dictUrl?: string): Promise<string[] | null> {
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

function pickOcrLogits(outputs: ort.InferenceSession.ReturnType): ort.Tensor | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[0] === 1) {
      return value;
    }
  }
  return null;
}

function decodeCtcGreedy(logits: Float32Array, steps: number, classes: number): number[] {
  const indices: number[] = [];
  let prev = -1;
  for (let t = 0; t < steps; t += 1) {
    let best = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    const offset = t * classes;
    for (let c = 0; c < classes; c += 1) {
      const v = logits[offset + c];
      if (v > bestVal) {
        bestVal = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      indices.push(best);
    }
    prev = best;
  }
  return indices;
}

function tokenToText(token: number, charset: string[] | null): string {
  if (!charset) {
    return "";
  }
  const idx = token - 1;
  if (idx < 0 || idx >= charset.length) {
    return "";
  }
  return charset[idx];
}

function tokenToTextAutoregressive(token: number, charset: string[] | null): string {
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

function getOutputByName(outputs: ort.InferenceSession.ReturnType, preferred: string, rank: number): ort.Tensor | null {
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

function findInputName(inputNames: readonly string[], expected: string): string | null {
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

function getInputDim(session: ort.InferenceSession, inputName: string, axis: number, fallback: number): number {
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

function avgLogProbToConfidence(probs: number[]): number {
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

function pointToSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  if (denom <= 1e-6) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function quadDistance(a: ReturnType<typeof getRegionQuad>, b: ReturnType<typeof getRegionQuad>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i += 1) {
    const p = a[i];
    for (let j = 0; j < 4; j += 1) {
      const q1 = b[j];
      const q2 = b[(j + 1) % 4];
      best = Math.min(best, pointToSegmentDistance(p.x, p.y, q1.x, q1.y, q2.x, q2.y));
    }
  }
  for (let i = 0; i < 4; i += 1) {
    const p = b[i];
    for (let j = 0; j < 4; j += 1) {
      const q1 = a[j];
      const q2 = a[(j + 1) % 4];
      best = Math.min(best, pointToSegmentDistance(p.x, p.y, q1.x, q1.y, q2.x, q2.y));
    }
  }
  return best;
}

function inferDirectionFromBox(region: TextRegion): Direction {
  if (region.direction === "h" || region.direction === "v") {
    return region.direction;
  }
  const quad = getRegionQuad(region);
  const topMid = { x: (quad[0].x + quad[1].x) * 0.5, y: (quad[0].y + quad[1].y) * 0.5 };
  const botMid = { x: (quad[2].x + quad[3].x) * 0.5, y: (quad[2].y + quad[3].y) * 0.5 };
  const rightMid = { x: (quad[1].x + quad[2].x) * 0.5, y: (quad[1].y + quad[2].y) * 0.5 };
  const leftMid = { x: (quad[3].x + quad[0].x) * 0.5, y: (quad[3].y + quad[0].y) * 0.5 };
  const vLen = Math.hypot(botMid.x - topMid.x, botMid.y - topMid.y);
  const hLen = Math.hypot(rightMid.x - leftMid.x, rightMid.y - leftMid.y);
  return vLen >= hLen ? "v" : "h";
}

function canMergeDirectionGroup(a: TextRegion, b: TextRegion): boolean {
  const qa = getRegionQuad(a);
  const qb = getRegionQuad(b);
  const fa = Math.max(2, Math.min(a.box.width, a.box.height));
  const fb = Math.max(2, Math.min(b.box.width, b.box.height));
  const charSize = Math.max(2, Math.min(fa, fb));
  const dist = quadDistance(qa, qb);
  if (dist > 2 * charSize) {
    return false;
  }
  if (Math.max(fa, fb) / charSize > 1.5) {
    return false;
  }
  const arA = a.box.width / Math.max(1, a.box.height);
  const arB = b.box.width / Math.max(1, b.box.height);
  if (arA > 1 && arB < 1) {
    return false;
  }
  if (arB > 1 && arA < 1) {
    return false;
  }
  return true;
}

function generateTextDirection(regions: TextRegion[]): DirectedRegion[] {
  const n = regions.length;
  if (n === 0) {
    return [];
  }
  const graph: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (!canMergeDirectionGroup(regions[i], regions[j])) {
        continue;
      }
      graph[i].push(j);
      graph[j].push(i);
    }
  }
  const visited = new Uint8Array(n);
  const output: DirectedRegion[] = [];
  for (let i = 0; i < n; i += 1) {
    if (visited[i] === 1) {
      continue;
    }
    const stack: number[] = [i];
    visited[i] = 1;
    const component: number[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      component.push(current);
      for (const next of graph[current]) {
        if (visited[next] === 1) {
          continue;
        }
        visited[next] = 1;
        stack.push(next);
      }
    }

    let votesH = 0;
    let votesV = 0;
    for (const idx of component) {
      const d = inferDirectionFromBox(regions[idx]);
      if (d === "h") {
        votesH += 1;
      } else {
        votesV += 1;
      }
    }
    const majority: Direction = votesV > votesH ? "v" : "h";
    component.sort((ia, ib) => {
      const a = regions[ia].box;
      const b = regions[ib].box;
      if (majority === "h") {
        return a.y + a.height / 2 - (b.y + b.height / 2);
      }
      return -(a.x + a.width) + (b.x + b.width);
    });
    for (const idx of component) {
      output.push({ region: regions[idx], direction: majority });
    }
  }
  return output;
}

async function decodeAutoregressiveWithBeam(
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
  }
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

      const outputs = await session.run({
        [imageInput]: imageTensor,
        [charIdxInput]: new ort.Tensor("int64", charData, [1, seqLen]),
        [decoderMaskInput]: new ort.Tensor("bool", decoderMask, [1, seqLen]),
        [encoderMaskInput]: new ort.Tensor("bool", encoderMask, [1, encoderLen])
      });

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
    const decoded = normalizeText(hypothesis.tokenIds.slice(1).map((id) => tokenToTextAutoregressive(id, charset)).join(""));
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

type BatchDecodeInput = {
  inputData: OcrInputData;
  validEncoderLength: number;
};

type BatchDecodeOutput = {
  text: string;
  confidence: number;
  tokenIds: number[];
  inputData: OcrInputData;
  validEncoderLength: number;
};

/**
 * Run greedy AR decode for multiple regions in lockstep.
 * Uses a fixed-size batch and reuses decode buffers across steps to reduce CPU churn.
 * Only works correctly when OCR_BEAM_WIDTH === 1 (greedy).
 */
async function decodeBatchAutoregressive(
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
  }
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

    const outputs = await session.run({
      [imageInput]: batchImage,
      [charIdxInput]: new ort.Tensor("int64", batchCharData, [N, seqLen]),
      [decoderMaskInput]: new ort.Tensor("bool", batchDecoderMask, [N, seqLen]),
      [encoderMaskInput]: new ort.Tensor("bool", batchEncoderMask, [N, encoderLen])
    });

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
    const text = normalizeText(tokenIds.map((id) => tokenToTextAutoregressive(id, charset)).join(""));
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

/**
 * Pick the logits tensor from batch output. Unlike pickOcrLogits which checks dims[0]===1,
 * this checks dims[0]===batchN.
 */
function pickBatchOcrLogits(outputs: ort.InferenceSession.ReturnType, batchN: number): ort.Tensor | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 3 && value.dims[0] === batchN && value.data instanceof Float32Array) {
      const classes = value.dims[2];
      // The logits tensor has a large number of classes (vocabulary size).
      // Distinguish it from fg/bg outputs (which have 3 channels) and fg_ind/bg_ind (which have 2 channels).
      if (classes > 10) {
        return value;
      }
    }
  }
  return null;
}

type OcrColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

function extractColorsFromOutputs(
  fg: Float32Array,
  bg: Float32Array,
  fgInd: Float32Array,
  bgInd: Float32Array,
  stepsPerSample: number,
  sampleOffset: number,
  tokenCount: number
): OcrColorResult | null {
  const maxSteps = Math.min(tokenCount, stepsPerSample);
  if (maxSteps <= 0) {
    return null;
  }

  let fr = 0;
  let fgCh = 0;
  let fb = 0;
  let br = 0;
  let bgCh = 0;
  let bb = 0;
  let cntFg = 0;
  let cntBg = 0;

  for (let t = 0; t < maxSteps; t += 1) {
    const fgBase = (sampleOffset + t) * 3;
    const bgBase = (sampleOffset + t) * 3;
    const fgIndBase = (sampleOffset + t) * 2;
    const bgIndBase = (sampleOffset + t) * 2;
    const hasFg = fgInd[fgIndBase + 1] > fgInd[fgIndBase];
    const hasBg = bgInd[bgIndBase + 1] > bgInd[bgIndBase];
    if (hasFg) {
      fr += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      fgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      fb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntFg += 1;
    }
    if (hasBg) {
      br += Math.round(Math.max(0, Math.min(1, bg[bgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, bg[bgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, bg[bgBase + 2])) * 255);
      cntBg += 1;
    } else {
      br += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntBg += 1;
    }
  }

  const fgColor: [number, number, number] = [
    cntFg > 0 ? Math.round(fr / cntFg) : 0,
    cntFg > 0 ? Math.round(fgCh / cntFg) : 0,
    cntFg > 0 ? Math.round(fb / cntFg) : 0
  ];
  const bgColor: [number, number, number] = [
    cntBg > 0 ? Math.round(br / cntBg) : 0,
    cntBg > 0 ? Math.round(bgCh / cntBg) : 0,
    cntBg > 0 ? Math.round(bb / cntBg) : 0
  ];
  return { fgColor, bgColor };
}

async function decodeTokenColors(
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
    tokenIds: number[];
  }
): Promise<OcrColorResult | null> {
  const { imageInput, imageTensor, charIdxInput, decoderMaskInput, encoderMaskInput } = inputs;
  const { seqLen, encoderLen, validEncoderLength, tokenIds } = options;
  if (tokenIds.length === 0) {
    return null;
  }
  const charData = new BigInt64Array(seqLen);
  charData.fill(OCR_AR_PAD_BIGINT);
  charData[0] = OCR_AR_START_BIGINT;
  for (let i = 0; i < tokenIds.length && i + 1 < seqLen; i += 1) {
    charData[i + 1] = BigInt(tokenIds[i]);
  }

  const decoderMask = new Array<boolean>(seqLen).fill(true);
  for (let i = 0; i < tokenIds.length + 1 && i < seqLen; i += 1) {
    decoderMask[i] = false;
  }

  const encoderMask = new Array<boolean>(encoderLen).fill(false);
  for (let i = validEncoderLength; i < encoderLen; i += 1) {
    encoderMask[i] = true;
  }

  const outputs = await session.run({
    [imageInput]: imageTensor,
    [charIdxInput]: new ort.Tensor("int64", charData, [1, seqLen]),
    [decoderMaskInput]: new ort.Tensor("bool", decoderMask, [1, seqLen]),
    [encoderMaskInput]: new ort.Tensor("bool", encoderMask, [1, encoderLen])
  });

  const fg = getOutputByName(outputs, "fg", 3);
  const bg = getOutputByName(outputs, "bg", 3);
  const fgInd = getOutputByName(outputs, "fg_ind", 3);
  const bgInd = getOutputByName(outputs, "bg_ind", 3);
  if (!fg || !bg || !fgInd || !bgInd) {
    return null;
  }
  if (!(fg.data instanceof Float32Array) || !(bg.data instanceof Float32Array) || !(fgInd.data instanceof Float32Array) || !(bgInd.data instanceof Float32Array)) {
    return null;
  }

  const stepsPerSample = Math.min(fg.dims[1] ?? 0, bg.dims[1] ?? 0, fgInd.dims[1] ?? 0, bgInd.dims[1] ?? 0);
  return extractColorsFromOutputs(fg.data, bg.data, fgInd.data, bgInd.data, stepsPerSample, 0, tokenIds.length);
}

type BatchColorItem = {
  inputData: OcrInputData;
  validEncoderLength: number;
  tokenIds: number[];
};

async function decodeTokenColorsBatch(
  session: ort.InferenceSession,
  inputNames: {
    imageInput: string;
    charIdxInput: string;
    decoderMaskInput: string;
    encoderMaskInput: string;
  },
  items: BatchColorItem[],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number
): Promise<(OcrColorResult | null)[]> {
  const N = items.length;
  if (N === 0) {
    return [];
  }

  const { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput } = inputNames;

  const batchImage = buildBatchImageTensor(items.map((item) => item.inputData), inputHeight, inputWidth);
  const batchCharData = new BigInt64Array(N * seqLen);
  const batchDecoderMask = new Array<boolean>(N * seqLen);
  const batchEncoderMask = new Array<boolean>(N * encoderLen);

  for (let n = 0; n < N; n += 1) {
    const { validEncoderLength, tokenIds } = items[n];
    const charOffset = n * seqLen;
    for (let i = 0; i < seqLen; i += 1) {
      batchCharData[charOffset + i] = OCR_AR_PAD_BIGINT;
    }
    batchCharData[charOffset] = OCR_AR_START_BIGINT;
    for (let i = 0; i < tokenIds.length && i + 1 < seqLen; i += 1) {
      batchCharData[charOffset + i + 1] = BigInt(tokenIds[i]);
    }

    const dmOffset = n * seqLen;
    for (let i = 0; i < seqLen; i += 1) {
      batchDecoderMask[dmOffset + i] = i >= tokenIds.length + 1;
    }

    const emOffset = n * encoderLen;
    for (let i = 0; i < encoderLen; i += 1) {
      batchEncoderMask[emOffset + i] = i >= validEncoderLength;
    }
  }

  const outputs = await session.run({
    [imageInput]: batchImage,
    [charIdxInput]: new ort.Tensor("int64", batchCharData, [N, seqLen]),
    [decoderMaskInput]: new ort.Tensor("bool", batchDecoderMask, [N, seqLen]),
    [encoderMaskInput]: new ort.Tensor("bool", batchEncoderMask, [N, encoderLen])
  });

  const fg = getOutputByName(outputs, "fg", 3);
  const bg = getOutputByName(outputs, "bg", 3);
  const fgInd = getOutputByName(outputs, "fg_ind", 3);
  const bgInd = getOutputByName(outputs, "bg_ind", 3);
  if (!fg || !bg || !fgInd || !bgInd) {
    return items.map(() => null);
  }
  if (!(fg.data instanceof Float32Array) || !(bg.data instanceof Float32Array) || !(fgInd.data instanceof Float32Array) || !(bgInd.data instanceof Float32Array)) {
    return items.map(() => null);
  }

  const stepsPerSample = fg.dims[1] ?? 0;
  const results: (OcrColorResult | null)[] = [];
  for (let n = 0; n < N; n += 1) {
    results.push(
      extractColorsFromOutputs(
        fg.data,
        bg.data,
        fgInd.data,
        bgInd.data,
        stepsPerSample,
        n * stepsPerSample,
        items[n].tokenIds.length
      )
    );
  }
  return results;
}

type OcrInputData = {
  data: Float32Array;
  tensor: ort.Tensor;
  resizedWidth: number;
};

function buildOcrInput(
  image: HTMLImageElement,
  region: TextRegion,
  direction: Direction,
  inputHeight: number,
  inputWidth: number,
  normalize: "zero_to_one" | "minus_one_to_one"
): OcrInputData {
  const source = getTransformedRegion(image, region, direction, inputHeight);
  const srcWidth = Math.max(1, source.width);
  const srcHeight = Math.max(1, source.height);
  const ratio = srcWidth / srcHeight;
  const resizedWidth = Math.max(1, Math.min(inputWidth, Math.round(ratio * inputHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = inputWidth;
  canvas.height = inputHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("OCR ONNX 预处理阶段无法创建画布上下文");
  }
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, inputWidth, inputHeight);
  ctx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, resizedWidth, inputHeight);
  const pixelData = ctx.getImageData(0, 0, inputWidth, inputHeight).data;
  const area = inputWidth * inputHeight;
  const input = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const r = pixelData[p];
    const g = pixelData[p + 1];
    const b = pixelData[p + 2];
    if (normalize === "minus_one_to_one") {
      input[i] = r / 127.5 - 1;
      input[area + i] = g / 127.5 - 1;
      input[2 * area + i] = b / 127.5 - 1;
    } else {
      input[i] = r / 255;
      input[area + i] = g / 255;
      input[2 * area + i] = b / 255;
    }
  }
  return {
    data: input,
    tensor: new ort.Tensor("float32", input, [1, 3, inputHeight, inputWidth]),
    resizedWidth
  };
}

function buildBatchImageTensor(
  inputs: OcrInputData[],
  inputHeight: number,
  inputWidth: number
): ort.Tensor {
  const N = inputs.length;
  const pixelsPerImage = 3 * inputHeight * inputWidth;
  const batchData = new Float32Array(N * pixelsPerImage);
  for (let i = 0; i < N; i += 1) {
    batchData.set(inputs[i].data, i * pixelsPerImage);
  }
  return new ort.Tensor("float32", batchData, [N, 3, inputHeight, inputWidth]);
}

function getRegionQuad(region: TextRegion): [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number }
] {
  if (region.quad && region.quad.length === 4) {
    return region.quad;
  }
  const x0 = region.box.x;
  const y0 = region.box.y;
  const x1 = region.box.x + region.box.width;
  const y1 = region.box.y + region.box.height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ];
}

function sortQuadPoints(points: [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number }
]): [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number }
] {
  const pts = points.map((p) => ({ x: p.x, y: p.y }));
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.x - p.y);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.max(...diffs))];
  const bl = pts[diffs.indexOf(Math.min(...diffs))];
  return [tl, tr, br, bl];
}

function solveLinear8(a: number[][], b: number[]): number[] | null {
  const n = 8;
  const mat = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(mat[row][col]) > Math.abs(mat[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(mat[pivot][col]) < 1e-9) {
      return null;
    }
    if (pivot !== col) {
      const tmp = mat[col];
      mat[col] = mat[pivot];
      mat[pivot] = tmp;
    }
    const diag = mat[col][col];
    for (let k = col; k <= n; k += 1) {
      mat[col][k] /= diag;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = mat[row][col];
      if (Math.abs(factor) < 1e-12) {
        continue;
      }
      for (let k = col; k <= n; k += 1) {
        mat[row][k] -= factor * mat[col][k];
      }
    }
  }
  return mat.map((row) => row[n]);
}

function computeHomography(
  src: Array<{ x: number; y: number }>,
  dst: Array<{ x: number; y: number }>
): number[] | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const x = src[i].x;
    const y = src[i].y;
    const u = dst[i].x;
    const v = dst[i].y;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const solved = solveLinear8(a, b);
  if (!solved) {
    return null;
  }
  return [
    solved[0], solved[1], solved[2],
    solved[3], solved[4], solved[5],
    solved[6], solved[7], 1
  ];
}

function invert3x3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) {
    return null;
  }
  const invDet = 1 / det;
  return [
    A * invDet, D * invDet, G * invDet,
    B * invDet, E * invDet, H * invDet,
    C * invDet, F * invDet, I * invDet
  ];
}

function sampleBilinear(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;
  const idx00 = (y0 * width + x0) * 4;
  const idx10 = (y0 * width + x1) * 4;
  const idx01 = (y1 * width + x0) * 4;
  const idx11 = (y1 * width + x1) * 4;
  const out: [number, number, number, number] = [0, 0, 0, 255];
  for (let c = 0; c < 4; c += 1) {
    const v00 = src[idx00 + c];
    const v10 = src[idx10 + c];
    const v01 = src[idx01 + c];
    const v11 = src[idx11 + c];
    const v0 = v00 * (1 - dx) + v10 * dx;
    const v1 = v01 * (1 - dx) + v11 * dx;
    out[c as 0 | 1 | 2 | 3] = Math.round(v0 * (1 - dy) + v1 * dy);
  }
  return out;
}

function warpPerspectiveRegion(
  sourceCanvas: HTMLCanvasElement,
  localQuad: Array<{ x: number; y: number }>,
  outW: number,
  outH: number
): HTMLCanvasElement | null {
  const dstQuad = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 }
  ];
  const h = computeHomography(localQuad, dstQuad);
  if (!h) {
    return null;
  }
  const hinv = invert3x3(h);
  if (!hinv) {
    return null;
  }

  const srcCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) {
    return null;
  }
  const srcData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) {
    return null;
  }
  const outImage = outCtx.createImageData(outW, outH);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const denom = hinv[6] * x + hinv[7] * y + hinv[8];
      if (Math.abs(denom) < 1e-9) {
        continue;
      }
      const sx = (hinv[0] * x + hinv[1] * y + hinv[2]) / denom;
      const sy = (hinv[3] * x + hinv[4] * y + hinv[5]) / denom;
      if (sx < 0 || sy < 0 || sx >= sourceCanvas.width - 1 || sy >= sourceCanvas.height - 1) {
        continue;
      }
      const [r, g, b, a] = sampleBilinear(srcData, sourceCanvas.width, sourceCanvas.height, sx, sy);
      const idx = (y * outW + x) * 4;
      outImage.data[idx] = r;
      outImage.data[idx + 1] = g;
      outImage.data[idx + 2] = b;
      outImage.data[idx + 3] = a;
    }
  }
  outCtx.putImageData(outImage, 0, 0);
  return outCanvas;
}

function rotate90CounterClockwise(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return source;
  }
  ctx.translate(0, canvas.height);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function getTransformedRegion(
  image: HTMLImageElement,
  region: TextRegion,
  direction: Direction,
  textHeight: number
): HTMLCanvasElement {
  const quad = sortQuadPoints(getRegionQuad(region));
  const imW = image.naturalWidth;
  const imH = image.naturalHeight;
  const minX = Math.max(0, Math.floor(Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x)));
  const minY = Math.max(0, Math.floor(Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y)));
  const maxX = Math.min(imW, Math.ceil(Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x)));
  const maxY = Math.min(imH, Math.ceil(Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y)));
  const cropW = Math.max(1, maxX - minX);
  const cropH = Math.max(1, maxY - minY);

  const source = document.createElement("canvas");
  source.width = cropW;
  source.height = cropH;
  const sctx = source.getContext("2d");
  if (!sctx) {
    throw new Error("OCR 透视裁切阶段无法创建画布上下文");
  }
  sctx.drawImage(image, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  const localQuad = quad.map((p) => ({ x: p.x - minX, y: p.y - minY }));

  const mid = [
    { x: (localQuad[0].x + localQuad[1].x) / 2, y: (localQuad[0].y + localQuad[1].y) / 2 },
    { x: (localQuad[1].x + localQuad[2].x) / 2, y: (localQuad[1].y + localQuad[2].y) / 2 },
    { x: (localQuad[2].x + localQuad[3].x) / 2, y: (localQuad[2].y + localQuad[3].y) / 2 },
    { x: (localQuad[3].x + localQuad[0].x) / 2, y: (localQuad[3].y + localQuad[0].y) / 2 }
  ];
  const vVec = { x: mid[2].x - mid[0].x, y: mid[2].y - mid[0].y };
  const hVec = { x: mid[1].x - mid[3].x, y: mid[1].y - mid[3].y };
  const normV = Math.hypot(vVec.x, vVec.y);
  const normH = Math.hypot(hVec.x, hVec.y);
  if (normV <= 1e-4 || normH <= 1e-4) {
    return source;
  }
  const ratio = normV / normH;

  let outW: number;
  let outH: number;
  if (direction === "h") {
    outH = Math.max(2, Math.floor(textHeight));
    outW = Math.max(2, Math.round(textHeight / ratio));
  } else {
    outW = Math.max(2, Math.floor(textHeight));
    outH = Math.max(2, Math.round(textHeight * ratio));
  }

  const warped = warpPerspectiveRegion(source, localQuad, outW, outH);
  if (!warped) {
    return source;
  }
  if (direction === "v") {
    return rotate90CounterClockwise(warped);
  }
  return warped;
}

async function runOcrByOnnxWithSession(
  image: HTMLImageElement,
  detectedRegions: TextRegion[],
  model: Awaited<ReturnType<typeof getModel>>,
  session: ort.InferenceSession
): Promise<TextRegion[]> {
  const charset = await loadCharset(model.dictUrl);
  const inputHeight = model.input?.[0] ?? 48;
  const inputWidth = model.input?.[1] ?? 320;
  const normalize = model.normalize ?? "minus_one_to_one";
  const imageInput = session.inputNames[0];
  if (!imageInput) {
    return [];
  }

  const charIdxInput = findInputName(session.inputNames, "char_idx");
  const decoderMaskInput = findInputName(session.inputNames, "decoder_mask");
  const encoderMaskInput = findInputName(session.inputNames, "encoder_mask");
  if (charIdxInput && decoderMaskInput && encoderMaskInput) {
    const seqLen = getInputDim(session, charIdxInput, 1, 64);
    const encoderLen = getInputDim(session, encoderMaskInput, 1, 80);
    const maxSteps = Math.max(1, seqLen - 1);

    const candidates = generateTextDirection(detectedRegions);

    // Phase 1: preprocess all images, then run batched greedy AR decoding.
    type DecodedCandidate = {
      region: TextRegion;
      direction: Direction;
      text: string;
      confidence: number;
      tokenIds: number[];
      inputData: OcrInputData;
      validEncoderLength: number;
    };
    const decoded: DecodedCandidate[] = [];

    // Preprocess all candidates upfront.
    type PreparedCandidate = {
      region: TextRegion;
      direction: Direction;
      inputData: OcrInputData;
      validEncoderLength: number;
    };
    const prepared: PreparedCandidate[] = [];
    for (const item of candidates) {
      const { region, direction } = item;
      try {
        const inputData = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize);
        const validEncoderLength = Math.min(encoderLen, Math.floor((inputData.resizedWidth + 3) / 4) + 2);
        prepared.push({ region, direction, inputData, validEncoderLength });
      } catch {
        // Skip regions that fail preprocessing.
        continue;
      }
    }

    // Process in batches of OCR_DECODE_BATCH_SIZE.
    for (let chunkStart = 0; chunkStart < prepared.length; chunkStart += OCR_DECODE_BATCH_SIZE) {
      const chunk = prepared.slice(chunkStart, chunkStart + OCR_DECODE_BATCH_SIZE);
      try {
        const batchItems: BatchDecodeInput[] = chunk.map((c) => ({
          inputData: c.inputData,
          validEncoderLength: c.validEncoderLength
        }));
        const batchResults = await decodeBatchAutoregressive(
          session,
          { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput },
          batchItems,
          { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth }
        );
        for (let i = 0; i < batchResults.length; i += 1) {
          const result = batchResults[i];
          const candidate = chunk[i];
          if (result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD) {
            decoded.push({
              region: candidate.region,
              direction: candidate.direction,
              text: result.text,
              confidence: result.confidence,
              tokenIds: result.tokenIds,
              inputData: result.inputData,
              validEncoderLength: result.validEncoderLength
            });
          }
        }
      } catch (error) {
        if (isContextLostRuntimeError(error)) {
          throw error;
        }
        // Fallback: decode this chunk one-by-one.
        for (const candidate of chunk) {
          try {
            const result = await decodeAutoregressiveWithBeam(
              session,
              {
                imageInput,
                imageTensor: candidate.inputData.tensor,
                charIdxInput,
                decoderMaskInput,
                encoderMaskInput
              },
              { seqLen, encoderLen, validEncoderLength: candidate.validEncoderLength, maxSteps, charset }
            );
            if (result && result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD) {
              decoded.push({
                region: candidate.region,
                direction: candidate.direction,
                text: result.text,
                confidence: result.confidence,
                tokenIds: result.tokenIds,
                inputData: candidate.inputData,
                validEncoderLength: candidate.validEncoderLength
              });
            }
          } catch (innerError) {
            if (isContextLostRuntimeError(innerError)) {
              throw innerError;
            }
            continue;
          }
        }
      }
    }

    if (decoded.length === 0) {
      return [];
    }

    // Phase 2: batch color decoding for all successfully decoded regions.
    const colorItems: BatchColorItem[] = decoded.map((d) => ({
      inputData: d.inputData,
      validEncoderLength: d.validEncoderLength,
      tokenIds: d.tokenIds
    }));

    let batchColors: (OcrColorResult | null)[];
    try {
      batchColors = await decodeTokenColorsBatch(
        session,
        { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput },
        colorItems,
        seqLen,
        encoderLen,
        inputHeight,
        inputWidth
      );
    } catch (error) {
      if (isContextLostRuntimeError(error)) {
        throw error;
      }
      // Fall back to per-region color decode on batch failure.
      batchColors = [];
      for (const d of decoded) {
        try {
          const colors = await decodeTokenColors(
            session,
            { imageInput, imageTensor: d.inputData.tensor, charIdxInput, decoderMaskInput, encoderMaskInput },
            { seqLen, encoderLen, validEncoderLength: d.validEncoderLength, tokenIds: d.tokenIds }
          );
          batchColors.push(colors);
        } catch {
          batchColors.push(null);
        }
      }
    }

    const next: TextRegion[] = [];
    for (let i = 0; i < decoded.length; i += 1) {
      const d = decoded[i];
      const colors = batchColors[i] ?? null;
      next.push({
        ...d.region,
        direction: d.direction,
        prob: d.confidence,
        fgColor: colors?.fgColor,
        bgColor: colors?.bgColor,
        sourceText: d.text,
        translatedText: ""
      });
    }

    return next;
  }

  const next: TextRegion[] = [];
  const candidates = generateTextDirection(detectedRegions);
  for (const item of candidates) {
    const { region, direction } = item;
    let bestText = "";
    let bestLength = 0;
    const { tensor } = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize);
    let outputs: ort.InferenceSession.ReturnType;
    try {
      outputs = await session.run({ [imageInput]: tensor });
    } catch (error) {
      if (isContextLostRuntimeError(error)) {
        throw error;
      }
      continue;
    }
    const logitsTensor = pickOcrLogits(outputs);
    if (!logitsTensor) {
      continue;
    }
    const dims = logitsTensor.dims;
    let steps = 0;
    let classes = 0;
    let logits: Float32Array | null = null;
    const raw = logitsTensor.data;
    if (raw instanceof Float32Array) {
      if (dims[1] > dims[2]) {
        classes = dims[1];
        steps = dims[2];
        logits = new Float32Array(steps * classes);
        for (let c = 0; c < classes; c += 1) {
          for (let t = 0; t < steps; t += 1) {
            logits[t * classes + c] = raw[c * steps + t];
          }
        }
      } else {
        steps = dims[1];
        classes = dims[2];
        logits = raw;
      }
    }
    if (!logits || steps <= 0 || classes <= 1) {
      continue;
    }
    const ids = decodeCtcGreedy(logits, steps, classes);
    const text = normalizeText(ids.map((id) => tokenToText(id, charset)).join(""));
    if (text.length > bestLength) {
      bestText = text;
      bestLength = text.length;
    }

    if (bestText.length > 0) {
      next.push({
        ...region,
        direction,
        sourceText: bestText,
        translatedText: ""
      });
    }
  }
  return next;
}

async function runOcrByOnnx(image: HTMLImageElement, detectedRegions: TextRegion[]): Promise<OcrResult> {
  const model = await getModel("ocr");
  const primaryHandle = await getModelSession("ocr", ["webgpu", "webnn", "wasm"]);

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;

  try {
    const regions = await runOcrByOnnxWithSession(image, detectedRegions, model, primaryHandle.session);
    return { regions, actualProvider, actualWebnnDeviceType };
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

    let recovered: TextRegion[] | null = null;
    let lastFallbackError: unknown = null;
    console.warn(`[ocr] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await getModelSession("ocr", preferred);
        recovered = await runOcrByOnnxWithSession(image, detectedRegions, model, handle.session);
        if (handle.provider !== primaryHandle.provider) {
          console.warn(`[ocr] 已回退到 ${handle.provider}`);
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
      throw new Error(`OCR 推理失败且回退失败: ${message} | fallback: ${fallbackMessage}`);
    }

    return { regions: recovered, actualProvider, actualWebnnDeviceType };
  }
}

export async function runOcr(image: HTMLImageElement, detectedRegions: TextRegion[]): Promise<OcrResult> {
  const onnxResult = await runOcrByOnnx(image, detectedRegions);
  if (onnxResult.regions.length > 0) {
    return onnxResult;
  }
  throw new Error("OCR ONNX 未返回有效识别结果");
}
