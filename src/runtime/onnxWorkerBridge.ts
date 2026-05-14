import * as Comlink from "comlink";
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
  OnnxWorkerApi,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";
import { resolveAssetUrl } from "../shared/assetUrl";

// ---------------------------------------------------------------------------
// Worker singleton — created once, reused across pipeline calls.
//
// Content scripts run in the page's origin (e.g. https://x.com) and cannot
// create Workers pointing to chrome-extension:// URLs (same-origin policy).
// We fetch the Worker script, create a Blob URL, and instantiate the Worker
// from the Blob. The Worker then runs in the page's origin but can fetch
// extension resources (WASM, models) from chrome-extension:// URLs because
// they are listed in web_accessible_resources.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let proxy: Comlink.Remote<OnnxWorkerApi> | null = null;

async function ensureWorker(): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  if (worker && proxy) return { worker, proxy };

  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
  }).chrome;
  const scriptUrl = chromeApi?.runtime?.getURL?.("onnxWorker.js") ?? resolveAssetUrl("onnxWorker.js");

  const response = await fetch(scriptUrl);
  const scriptText = await response.text();
  const blob = new Blob([scriptText], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  worker = new Worker(blobUrl, { type: "module" });
  URL.revokeObjectURL(blobUrl);
  proxy = Comlink.wrap<OnnxWorkerApi>(worker);

  // Pass WASM paths to Worker (it can't access chrome.runtime from blob context)
  const ortPath = chromeApi?.runtime?.getURL?.("ort/") ?? "/ort/";
  await proxy.init(ortPath);

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
  return await (await getProxy()).runInference(sessionId, feeds);
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
  return await (await getProxy()).runOcrBatchDecode(sessionId, inputNames, items, options);
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
): Promise<(OcrColorResult | null)[]> {
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
): Promise<OcrColorResult | null> {
  return await (await getProxy()).runOcrColorSingle(sessionId, inputNames, imageData, imageDims, validEncoderLength, tokenIds, seqLen, encoderLen);
}

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  return await (await getProxy()).probeRuntime(modelUrl);
}

export async function disposeSession(sessionId: string): Promise<void> {
  await (await getProxy()).disposeSession(sessionId);
}

export async function disposeAll(): Promise<void> {
  await (await getProxy()).disposeAll();
}