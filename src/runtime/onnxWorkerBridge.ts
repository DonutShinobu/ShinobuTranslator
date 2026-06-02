import * as Comlink from "comlink";
import type { RuntimeProvider } from "./onnxTypes";
import type {
  TensorTransport,
  WorkerSessionHandle,
  InferenceResult,
  OcrInputNameSet,
  OcrSplitInputNameSet,
  OcrBatchDecodeInputItem,
  OcrBatchDecodeOptions,
  OcrBatchDecodeResult,
  OcrSingleDecodeResult,
  OcrColorBatchInputItem,
  OcrColorBatchResult,
  OcrColorSingleResult,
  OnnxWorkerApi,
  GpuDetectResult,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";
import { resolveAssetUrl } from "../shared/assetUrl";

// ---------------------------------------------------------------------------
// Worker singleton — created once, reused across pipeline calls.
//
// Prefer a Worker created directly from the extension URL so ORT's dynamic
// backend imports stay same-origin with the copied runtime files. Some content
// script contexts reject extension Workers, so keep the Blob Worker fallback.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let proxy: Comlink.Remote<OnnxWorkerApi> | null = null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function initWorker(candidate: Worker, ortPath: string, label: string): Promise<Comlink.Remote<OnnxWorkerApi>> {
  const candidateProxy = Comlink.wrap<OnnxWorkerApi>(candidate);
  const workerError = new Promise<never>((_resolve, reject) => {
    candidate.addEventListener("error", (event) => {
      reject(event.error ?? new Error(`${label} failed to load`));
    }, { once: true });
  });
  try {
    await withTimeout(Promise.race([candidateProxy.init(ortPath), workerError]), 10000, `${label} init`);
    return candidateProxy;
  } catch (error) {
    candidate.terminate();
    throw error;
  }
}

async function createBlobWorker(scriptUrl: string): Promise<Worker> {
  const response = await fetch(scriptUrl);
  const scriptText = await response.text();
  const blob = new Blob([scriptText], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    return new Worker(blobUrl, { type: "module" });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function ensureWorker(): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  if (worker && proxy) return { worker, proxy };

  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
  }).chrome;
  const scriptUrl = chromeApi?.runtime?.getURL?.("onnxWorker.js") ?? resolveAssetUrl("onnxWorker.js");
  const ortPath = chromeApi?.runtime?.getURL?.("ort/") ?? "/ort/";

  if (scriptUrl.startsWith("chrome-extension://")) {
    try {
      const directWorker = new Worker(scriptUrl, { type: "module" });
      const directProxy = await initWorker(directWorker, ortPath, "extension Worker");
      worker = directWorker;
      proxy = directProxy;
      return { worker, proxy };
    } catch {
      // Fall through to Blob Worker for content script contexts that reject
      // chrome-extension:// Worker scripts.
    }
  }

  const blobWorker = await createBlobWorker(scriptUrl);
  const blobProxy = await initWorker(blobWorker, ortPath, "blob Worker");
  worker = blobWorker;
  proxy = blobProxy;

  return { worker, proxy };
}

function getProxy(): Promise<Comlink.Remote<OnnxWorkerApi>> {
  return ensureWorker().then(({ proxy }) => proxy);
}

// ---------------------------------------------------------------------------
// Public API — thin async wrappers around comlink proxy calls.
//
// Input data (Float32Array / BigInt64Array) is sent via structured clone
// (not Transferable) so that the main thread retains ownership. This is
// critical for fallback paths: if the first inference attempt fails, the
// same preprocessed data must still be available to retry with a different
// provider. Output data is transferred by the Worker (zero-copy return).
// ---------------------------------------------------------------------------

export async function createSession(
  modelKey: string,
  modelUrl: string,
  preferred: RuntimeProvider[]
): Promise<WorkerSessionHandle> {
  return await (await getProxy()).createSession(modelKey, modelUrl, preferred);
}

export async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  const result = await (await getProxy()).runInference(sessionId, feeds);
  // Worker 推理失败时不抛异常，通过 InferenceResult.error 返回错误信息。
  // 调用者需要自行检查 error 字段。
  return result;
}

export async function runOcrBatchDecode(
  sessionId: string,
  inputNames: OcrInputNameSet,
  items: OcrBatchDecodeInputItem[],
  options: OcrBatchDecodeOptions
): Promise<OcrBatchDecodeResult> {
  return await (await getProxy()).runOcrBatchDecode(sessionId, inputNames, items, options);
}

export async function runOcrSplitBatchDecode(
  encoderSessionId: string,
  decoderSessionId: string,
  inputNames: OcrSplitInputNameSet,
  items: OcrBatchDecodeInputItem[],
  options: OcrBatchDecodeOptions
): Promise<OcrBatchDecodeResult> {
  return await (await getProxy()).runOcrSplitBatchDecode(encoderSessionId, decoderSessionId, inputNames, items, options);
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
): Promise<OcrSingleDecodeResult> {
  return await (await getProxy()).runOcrSingleDecode(sessionId, inputNames, imageData, imageDims, validEncoderLength, options);
}

export async function runOcrColorBatch(
  sessionId: string,
  inputNames: OcrInputNameSet,
  items: OcrColorBatchInputItem[],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number
): Promise<OcrColorBatchResult> {
  return await (await getProxy()).runOcrColorBatch(sessionId, inputNames, items, seqLen, encoderLen, inputHeight, inputWidth);
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
): Promise<OcrColorSingleResult> {
  return await (await getProxy()).runOcrColorSingle(sessionId, inputNames, imageData, imageDims, validEncoderLength, tokenIds, seqLen, encoderLen);
}

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  return await (await getProxy()).probeRuntime(modelUrl);
}

export async function runDetectWithGpuPreprocess(
  sessionId: string,
  imageSource: ImageBitmap
): Promise<GpuDetectResult> {
  const proxy = await getProxy();
  return await proxy.runDetectWithGpuPreprocess(
    sessionId,
    Comlink.transfer(imageSource, [imageSource])
  );
}

export async function disposeSession(sessionId: string): Promise<void> {
  await (await getProxy()).disposeSession(sessionId);
}

export async function disposeAll(): Promise<void> {
  await (await getProxy()).disposeAll();
}
