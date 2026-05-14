/**
 * ORT-independent constants and utility functions shared between
 * the main thread (ocr/index.ts) and the Worker (decodeAutoregressive.ts, color.ts).
 *
 * Extracted from decodeAutoregressive.ts so that the main thread
 * does not pull in onnxruntime-web via shared-chunk bundling.
 */

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

export type BatchDecodeInput = {
  regionId: string;
  inputData: import("./preprocess").OcrInputData;
  validEncoderLength: number;
};

export type BatchDecodeOutput = {
  text: string;
  confidence: number;
  tokenIds: number[];
  inputData: import("./preprocess").OcrInputData;
  validEncoderLength: number;
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

// --- Input name matching ---
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

// --- Confidence helpers ---
export function avgLogProbToConfidence(probs: number[]): number {
  if (probs.length === 0) {
    return 0;
  }
  const sumLog = probs.reduce((acc, p) => acc + Math.log(Math.max(1e-6, p)), 0);
  return Math.exp(sumLog / probs.length);
}