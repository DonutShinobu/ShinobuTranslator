/**
 * Unified ONNX Bridge — dynamically selects the correct implementation
 * based on the runtime environment.
 *
 * Browser: loads `onnxWorkerBridge` (Comlink + Web Worker → onnxruntime-web).
 * Node:    loads `onnxNodeBridge`   (direct calls → onnxruntime-node + CUDA EP).
 *
 * The bridge module is loaded lazily on first invocation and then cached.
 * All exported functions are async wrappers — since both underlying bridges
 * already export async functions, the wrapper overhead is minimal
 * (one extra `await loadBridge()` on the first call only).
 */

import type { RuntimeProvider } from "./onnxTypes";
import type {
  TensorTransport,
  WorkerSessionHandle,
  InferenceResult,
  OcrInputNameSet,
  OcrBatchDecodeInputItem,
  OcrBatchDecodeOutputItem,
  OcrSingleDecodeOutput,
  OcrColorBatchInputItem,
  OcrColorResult,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const isNode = typeof process !== "undefined" && !!process.versions?.node;

// ---------------------------------------------------------------------------
// Bridge module cache — loaded once, reused across pipeline calls
// ---------------------------------------------------------------------------

let bridge: any = null;

async function loadBridge() {
  if (bridge) return bridge;
  if (isNode) {
    bridge = await import("./onnxNodeBridge");
  } else {
    bridge = await import("./onnxWorkerBridge");
  }
  return bridge;
}

// ---------------------------------------------------------------------------
// Public API — thin async wrappers that resolve the bridge on first call
// ---------------------------------------------------------------------------

export async function createSession(
  modelKey: string,
  modelUrl: string,
  preferred: RuntimeProvider[]
): Promise<WorkerSessionHandle> {
  return (await loadBridge()).createSession(modelKey, modelUrl, preferred);
}

export async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  return (await loadBridge()).runInference(sessionId, feeds);
}

export async function runOcrBatchDecode(
  sessionId: string,
  inputNames: OcrInputNameSet,
  items: OcrBatchDecodeInputItem[],
  options: {
    seqLen: number;
    encoderLen: number;
    maxSteps: number;
    charset: string[] | null;
    inputHeight: number;
    inputWidth: number;
  }
): Promise<OcrBatchDecodeOutputItem[]> {
  return (await loadBridge()).runOcrBatchDecode(sessionId, inputNames, items, options);
}

export async function runOcrSingleDecode(
  sessionId: string,
  inputNames: OcrInputNameSet,
  imageData: Float32Array,
  imageDims: number[],
  validEncoderLength: number,
  options: {
    seqLen: number;
    encoderLen: number;
    maxSteps: number;
    charset: string[] | null;
  }
): Promise<OcrSingleDecodeOutput | null> {
  return (await loadBridge()).runOcrSingleDecode(sessionId, inputNames, imageData, imageDims, validEncoderLength, options);
}

export async function runOcrColorBatch(
  sessionId: string,
  inputNames: OcrInputNameSet,
  items: OcrColorBatchInputItem[],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number
): Promise<(OcrColorResult | null)[]> {
  return (await loadBridge()).runOcrColorBatch(sessionId, inputNames, items, seqLen, encoderLen, inputHeight, inputWidth);
}

export async function runOcrColorSingle(
  sessionId: string,
  inputNames: OcrInputNameSet,
  imageData: Float32Array,
  imageDims: number[],
  validEncoderLength: number,
  tokenIds: number[],
  seqLen: number,
  encoderLen: number
): Promise<OcrColorResult | null> {
  return (await loadBridge()).runOcrColorSingle(sessionId, inputNames, imageData, imageDims, validEncoderLength, tokenIds, seqLen, encoderLen);
}

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  return (await loadBridge()).probeRuntime(modelUrl);
}

export async function disposeSession(sessionId: string): Promise<void> {
  return (await loadBridge()).disposeSession(sessionId);
}

export async function disposeAll(): Promise<void> {
  return (await loadBridge()).disposeAll();
}