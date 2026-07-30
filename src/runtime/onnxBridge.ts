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
import type { OnnxSessionOptions } from "./onnxSessionOptions";
import type {
  TensorTransport,
  WorkerSessionHandle,
  InferenceResult,
  GpuDetectResult,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";
import { isNodeRuntime } from '@shinobu/browser-runtime/runtime-target';

// ---------------------------------------------------------------------------
// Bridge module cache — loaded once, reused across pipeline calls
// ---------------------------------------------------------------------------

type BridgeModule = Pick<
  typeof import("./onnxWorkerBridge"),
  | "createSession"
  | "runInference"
  | "probeRuntime"
  | "runDetectWithGpuPreprocess"
  | "disposeSession"
  | "disposeAll"
>;

let bridge: BridgeModule | null = null;

async function loadBridge(): Promise<BridgeModule> {
  if (bridge) return bridge;
  if (isNodeRuntime) {
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
  provider: RuntimeProvider,
  sessionOptions?: OnnxSessionOptions
): Promise<WorkerSessionHandle> {
  return (await loadBridge()).createSession(modelKey, modelUrl, provider, sessionOptions);
}

export async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  return (await loadBridge()).runInference(sessionId, feeds);
}

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  return (await loadBridge()).probeRuntime(modelUrl);
}

export async function runDetectWithGpuPreprocess(
  sessionId: string,
  imageSource: ImageBitmap
): Promise<GpuDetectResult> {
  return (await loadBridge()).runDetectWithGpuPreprocess(sessionId, imageSource);
}

export async function disposeSession(sessionId: string): Promise<void> {
  return (await loadBridge()).disposeSession(sessionId);
}

export async function disposeAll(): Promise<void> {
  return (await loadBridge()).disposeAll();
}
