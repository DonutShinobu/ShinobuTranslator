import * as ortAll from "onnxruntime-web/all";
import * as Comlink from "comlink";
import type { InferenceSession } from "onnxruntime-common";
import { toErrorMessage } from "../shared/utils";
import { isContextLostRuntimeError, isCreateTimeoutError } from "../runtime/onnxTypes";
import type { RuntimeProvider, WebNnDeviceType } from "../runtime/onnxTypes";
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
} from "../runtime/onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "../runtime/selfCheck";
import {
  decodeBatchAutoregressive,
  decodeAutoregressiveWithBeam,
} from "../pipeline/ocr/decodeAutoregressive";
import { decodeTokenColorsBatch, decodeTokenColors } from "../pipeline/ocr/color";
import type { OcrInputData } from "../pipeline/ocr/preprocess";

// ---------------------------------------------------------------------------
// ORT environment
// ---------------------------------------------------------------------------

let envInitialized = false;
let ortPathOverride: string | null = null;

function init(ortPath: string): Promise<void> {
  ortPathOverride = ortPath;
  return Promise.resolve();
}

function ensureOrtEnv(): void {
  if (envInitialized) return;

  // Blob URL Workers run in the page's origin and cannot access chrome.runtime.
  // The ORT WASM path must be provided by the main thread via init().
  const ortPath = ortPathOverride ?? "/ort/";

  const hwThreads =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 1;
  const canUseWasmThreads =
    typeof globalThis !== "undefined" && !!(globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  const wasmThreads = canUseWasmThreads ? Math.max(1, Math.min(8, hwThreads)) : 1;

  ortAll.env.wasm.wasmPaths = ortPath;
  ortAll.env.wasm.numThreads = wasmThreads;
  ortAll.env.wasm.proxy = false;

  if (ortAll.env.webgpu) {
    ortAll.env.webgpu.powerPreference = "high-performance";
  }

  if (!canUseWasmThreads && hwThreads > 1) {
    console.warn("[onnx-worker] 非 crossOriginIsolated，WASM 线程数被限制为 1");
  }

  envInitialized = true;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSION_CREATE_TIMEOUT_MS = 30000;
const perModelLocks = new Map<string, Promise<void>>();
const sessions = new Map<string, {
  session: InferenceSession;
  provider: RuntimeProvider;
  webnnDeviceType?: WebNnDeviceType;
  modelUrl: string;
}>();

async function withPerModelLock<T>(modelUrl: string, task: () => Promise<T>): Promise<T> {
  const previous = perModelLocks.get(modelUrl) ?? Promise.resolve();
  let release: () => void = () => undefined;
  perModelLocks.set(modelUrl, new Promise<void>((resolve) => { release = resolve; }));
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function probeWebNnAvailability(): { available: boolean; reason?: string } {
  const isSecure = typeof globalThis !== "undefined" && (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext === true;
  if (!isSecure) {
    return { available: false, reason: "当前不是安全上下文，WebNN 不可用" };
  }
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { ml?: unknown });
  if (!nav?.ml) {
    return { available: false, reason: "navigator.ml 不可用" };
  }
  return { available: true };
}

async function probeWebGpuAvailability(): Promise<{ available: boolean; reason?: string }> {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & {
    gpu?: { requestAdapter?: () => Promise<unknown> };
  });
  if (!nav?.gpu?.requestAdapter) {
    return { available: false, reason: "navigator.gpu 不可用" };
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: "navigator.gpu.requestAdapter() 返回空" };
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: `WebGPU 适配器初始化失败: ${toErrorMessage(error)}` };
  }
}

function getExecutionProviderAttempts(provider: RuntimeProvider): InferenceSession.ExecutionProviderConfig[] {
  if (provider === "webnn") {
    return [
      { name: "webnn", deviceType: "gpu", powerPreference: "high-performance" },
      { name: "webnn", deviceType: "cpu" },
      "webnn",
    ];
  }
  return [provider];
}

function inferWebNnDeviceType(ep: InferenceSession.ExecutionProviderConfig): WebNnDeviceType {
  if (typeof ep === "object" && ep !== null && "name" in ep && ep.name === "webnn") {
    if ("deviceType" in ep && ep.deviceType === "gpu") return "gpu";
    if ("deviceType" in ep && ep.deviceType === "cpu") return "cpu";
  }
  return "default";
}

async function createSessionWithTimeout(
  modelUrl: string,
  options: Parameters<typeof ortAll.InferenceSession.create>[1],
  timeoutMs: number
): Promise<InferenceSession> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      ortAll.InferenceSession.create(modelUrl, options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Session 创建超时(${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function createSession(
  modelKey: string,
  modelUrl: string,
  preferred: RuntimeProvider[]
): Promise<WorkerSessionHandle> {
  return withPerModelLock(modelUrl, async () => {
    ensureOrtEnv();

    // Check if session already cached
    const existing = sessions.get(modelKey);
    if (existing) {
      return {
        sessionId: modelKey,
        provider: existing.provider,
        webnnDeviceType: existing.webnnDeviceType,
        inputNames: [...existing.session.inputNames],
        outputNames: [...existing.session.outputNames],
      };
    }

    const normalized = preferred.filter((item, idx) => preferred.indexOf(item) === idx);
    const providerOrder: RuntimeProvider[] = [];
    const providerErrors: Partial<Record<RuntimeProvider, string>> = {};

    for (const provider of normalized) {
      if (provider === "webnn") {
        const probe = probeWebNnAvailability();
        if (probe.available) {
          providerOrder.push(provider);
        } else if (probe.reason) {
          providerErrors.webnn = probe.reason;
        }
        continue;
      }
      if (provider === "webgpu") {
        const probe = await probeWebGpuAvailability();
        if (probe.available) {
          providerOrder.push(provider);
        } else if (probe.reason) {
          providerErrors.webgpu = probe.reason;
        }
        continue;
      }
      providerOrder.push(provider);
    }

    if (providerOrder.length === 0) {
      providerOrder.push("wasm");
    }

    for (const provider of providerOrder) {
      const attemptErrors: string[] = [];
      let abortProvider = false;
      for (const ep of getExecutionProviderAttempts(provider)) {
        if (abortProvider) break;
        const maxAttempts = provider === "webnn" ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          try {
            const session = await createSessionWithTimeout(
              modelUrl,
              { executionProviders: [ep], graphOptimizationLevel: "all" },
              SESSION_CREATE_TIMEOUT_MS
            );

            const webnnDeviceType = provider === "webnn" ? inferWebNnDeviceType(ep) : undefined;

            if (provider === "wasm") {
              if (providerErrors.webnn) {
                console.warn(`[onnx-worker] WebNN 不可用，回退到 WASM: ${providerErrors.webnn}`);
              }
              if (providerErrors.webgpu) {
                console.warn(`[onnx-worker] WebGPU 不可用，回退到 WASM: ${providerErrors.webgpu}`);
              }
            }

            sessions.set(modelKey, { session, provider, webnnDeviceType, modelUrl });

            return {
              sessionId: modelKey,
              provider,
              webnnDeviceType,
              inputNames: [...session.inputNames],
              outputNames: [...session.outputNames],
            };
          } catch (error) {
            const message = toErrorMessage(error);
            attemptErrors.push(message);
            if (isCreateTimeoutError(message)) {
              abortProvider = true;
              break;
            }
            if (provider === "webnn" && attempt + 1 < maxAttempts && isContextLostRuntimeError(error)) {
              await new Promise((resolve) => setTimeout(resolve, 120));
              continue;
            }
            break;
          }
        }
      }
      providerErrors[provider] = attemptErrors.join(" || ");
    }

    const detail = ["webnn", "webgpu", "wasm"]
      .filter((p) => providerErrors[p as RuntimeProvider])
      .map((p) => `${p}: ${providerErrors[p as RuntimeProvider]}`)
      .join(" | ");

    throw new Error(`ONNX Session 创建失败: ${detail || "未知错误"}`);
  });
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

function tensorToTransport(tensor: ortAll.Tensor): TensorTransport {
  if (tensor.data instanceof Float32Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "float32" };
  }
  if (tensor.data instanceof BigInt64Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "int64" };
  }
  if (tensor.data instanceof Uint8Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "bool" };
  }
  // Fallback for other typed arrays
  if (tensor.type === "float32" && tensor.data instanceof Float32Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "float32" };
  }
  throw new Error(`不支持的 tensor 类型: ${tensor.type}`);
}

function transportToTensor(transport: TensorTransport): ortAll.Tensor {
  if (transport.type === "float32") {
    return new ortAll.Tensor("float32", transport.data as Float32Array, transport.dims);
  }
  if (transport.type === "int64") {
    return new ortAll.Tensor("int64", transport.data as BigInt64Array, transport.dims);
  }
  if (transport.type === "bool") {
    return new ortAll.Tensor("bool", transport.data as Uint8Array, transport.dims);
  }
  throw new Error(`不支持的 transport 类型: ${transport.type}`);
}

async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const ortFeeds: Record<string, ortAll.Tensor> = {};
  for (const [name, transport] of Object.entries(feeds)) {
    ortFeeds[name] = transportToTensor(transport);
  }

  const outputs = await entry.session.run(ortFeeds);

  const result: InferenceResult = { outputs: {} };
  const outTransferables: ArrayBuffer[] = [];
  for (const [name, tensor] of Object.entries(outputs)) {
    const transport = tensorToTransport(tensor);
    result.outputs[name] = transport;
    if (transport.data instanceof Float32Array) {
      outTransferables.push(transport.data.buffer as ArrayBuffer);
    } else if (transport.data instanceof BigInt64Array) {
      outTransferables.push(transport.data.buffer as ArrayBuffer);
    }
  }

  return Comlink.transfer(result, outTransferables);
}

// ---------------------------------------------------------------------------
// OCR batch decode (full AR loop in Worker)
// ---------------------------------------------------------------------------

async function runOcrBatchDecode(
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
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  // Reconstruct OcrInputData from transport items
  const batchItems: { regionId: string; inputData: OcrInputData; validEncoderLength: number }[] = items.map((item) => ({
    regionId: item.regionId,
    inputData: {
      data: item.imageData,
      dims: item.imageDims,
      resizedWidth: item.imageDims[3] ?? 0,
    },
    validEncoderLength: item.validEncoderLength,
  }));

  const batchResults = await decodeBatchAutoregressive(
    entry.session,
    inputNames,
    batchItems,
    options
  );

  const outputItems: OcrBatchDecodeOutputItem[] = batchResults.map((result, i) => ({
    regionId: items[i].regionId,
    text: result.text,
    confidence: result.confidence,
    tokenIds: result.tokenIds,
    imageData: items[i].imageData,
    imageDims: items[i].imageDims,
    validEncoderLength: result.validEncoderLength,
  }));

  return outputItems;
}

// ---------------------------------------------------------------------------
// OCR single-region fallback decode (beam search)
// ---------------------------------------------------------------------------

async function runOcrSingleDecode(
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
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const imageTensor = new ortAll.Tensor("float32", imageData, imageDims);
  const result = await decodeAutoregressiveWithBeam(
    entry.session,
    {
      imageInput: inputNames.imageInput,
      imageTensor,
      charIdxInput: inputNames.charIdxInput,
      decoderMaskInput: inputNames.decoderMaskInput,
      encoderMaskInput: inputNames.encoderMaskInput,
    },
    {
      seqLen: options.seqLen,
      encoderLen: options.encoderLen,
      validEncoderLength,
      maxSteps: options.maxSteps,
      charset: options.charset,
    }
  );

  if (!result) return null;
  return {
    text: result.text,
    confidence: result.confidence,
    tokenIds: result.tokenIds,
  };
}

// ---------------------------------------------------------------------------
// OCR color decode (batch)
// ---------------------------------------------------------------------------

async function runOcrColorBatch(
  sessionId: string,
  inputNames: OcrInputNameSet,
  items: OcrColorBatchInputItem[],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number
): Promise<(OcrColorResult | null)[]> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  // Reconstruct BatchColorItem[] from transport items
  const colorItems = items.map((item) => ({
    inputData: {
      data: item.imageData,
      dims: item.imageDims,
      resizedWidth: item.imageDims[3] ?? 0,
    } as OcrInputData,
    validEncoderLength: item.validEncoderLength,
    tokenIds: item.tokenIds,
  }));

  return await decodeTokenColorsBatch(
    entry.session,
    inputNames,
    colorItems,
    seqLen,
    encoderLen,
    inputHeight,
    inputWidth
  );
}

// ---------------------------------------------------------------------------
// OCR color decode (single)
// ---------------------------------------------------------------------------

async function runOcrColorSingle(
  sessionId: string,
  inputNames: OcrInputNameSet,
  imageData: Float32Array,
  imageDims: number[],
  validEncoderLength: number,
  tokenIds: number[],
  seqLen: number,
  encoderLen: number
): Promise<OcrColorResult | null> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const imageTensor = new ortAll.Tensor("float32", imageData, imageDims);
  const result = await decodeTokenColors(
    entry.session,
    {
      imageInput: inputNames.imageInput,
      imageTensor,
      charIdxInput: inputNames.charIdxInput,
      decoderMaskInput: inputNames.decoderMaskInput,
      encoderMaskInput: inputNames.encoderMaskInput,
    },
    {
      seqLen,
      encoderLen,
      validEncoderLength,
      tokenIds,
    }
  );

  return result;
}

// ---------------------------------------------------------------------------
// Runtime self-check (adapted for Worker context)
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "warn" | "fail" | "running" | "skip";

type RuntimeCheckItem = {
  id: string;
  title: string;
  status: CheckStatus;
  code?: string;
  message: string;
  detail?: string;
};

type NavigatorWithMl = Navigator & {
  ml?: unknown;
};

async function verifyWasmSession(modelUrl: string): Promise<{ ok: boolean; error?: string }> {
  ensureOrtEnv();
  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const session = await Promise.race([
      ortAll.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Session 创建超时(12000ms)`)), 12000);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (typeof (session as { release?: () => void }).release === "function") {
      (session as { release: () => void }).release();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

async function verifyWebnnSession(modelUrl: string): Promise<{ ok: boolean; error?: string }> {
  const attempts: Array<{ name: "webnn"; deviceType?: "gpu" | "cpu"; powerPreference?: "high-performance" } | "webnn"> = [
    { name: "webnn", deviceType: "gpu", powerPreference: "high-performance" },
    { name: "webnn", deviceType: "cpu" },
    "webnn",
  ];
  const errors: string[] = [];

  for (const ep of attempts) {
    try {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const session = await Promise.race([
        ortAll.InferenceSession.create(modelUrl, {
          executionProviders: [ep],
          graphOptimizationLevel: "all",
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Session 创建超时(12000ms)`)), 12000);
        }),
      ]);
      if (timer !== null) clearTimeout(timer);
      if (typeof (session as { release?: () => void }).release === "function") {
        (session as { release: () => void }).release();
      }
      return { ok: true };
    } catch (error) {
      errors.push(toErrorMessage(error));
    }
  }

  return { ok: false, error: errors.join(" || ") };
}

async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  ensureOrtEnv();

  const checks: RuntimeCheckItem[] = [];
  const nav = typeof navigator === "undefined" ? null : (navigator as NavigatorWithMl);
  const ua = nav?.userAgent ?? "unknown";

  const isSecure = typeof globalThis !== "undefined" && (globalThis as unknown as { isSecureContext?: boolean }).isSecureContext === true;
  checks.push({
    id: "env.security",
    title: "安全上下文",
    status: isSecure ? "pass" : "fail",
    code: isSecure ? undefined : "S001_INSECURE_CONTEXT",
    message: isSecure ? "Worker 为安全上下文" : "Worker 不是安全上下文，WebNN 可能不可用",
    detail: `isSecureContext=${String(isSecure)}, crossOriginIsolated=${String((globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false)}`,
  });

  const hasMlApi = Boolean(nav?.ml);
  checks.push({
    id: "webnn.api",
    title: "WebNN API 可见性",
    status: hasMlApi ? "pass" : "fail",
    code: hasMlApi ? undefined : "B002_NO_WEBNN",
    message: hasMlApi ? "navigator.ml 可用" : "navigator.ml 不可用",
    detail: `ua=${ua}`,
  });

  try {
    const response = await fetch(modelUrl, { method: "GET" });
    checks.push({
      id: "model.fetch",
      title: "诊断模型下载",
      status: response.ok ? "pass" : "fail",
      code: response.ok ? undefined : "O004_MODEL_FETCH_FAILED",
      message: response.ok ? "诊断模型可访问" : `诊断模型请求失败 (${response.status})`,
      detail: `url=${modelUrl}`,
    });
  } catch (error) {
    checks.push({
      id: "model.fetch",
      title: "诊断模型下载",
      status: "fail",
      code: "O004_MODEL_FETCH_FAILED",
      message: "诊断模型下载异常",
      detail: toErrorMessage(error),
    });
  }

  const webnnSession = hasMlApi ? await verifyWebnnSession(modelUrl) : { ok: false, error: "缺少 navigator.ml" };
  checks.push({
    id: "ort.webnn.session",
    title: "ORT WebNN 最小 Session",
    status: webnnSession.ok ? "pass" : "fail",
    code: webnnSession.ok ? undefined : "O002_ORT_WEBNN_BACKEND_UNAVAILABLE",
    message: webnnSession.ok ? "WebNN Session 创建成功" : "WebNN Session 创建失败",
    detail: webnnSession.error,
  });

  const wasmSession = await verifyWasmSession(modelUrl);
  checks.push({
    id: "ort.wasm.session",
    title: "ORT WASM 对照 Session",
    status: wasmSession.ok ? "pass" : "fail",
    code: wasmSession.ok ? undefined : "O003_ORT_WASM_ASSET_MISSING",
    message: wasmSession.ok ? "WASM Session 创建成功" : "WASM Session 创建失败",
    detail: wasmSession.error,
  });

  const effectiveRuntime: "webnn" | "wasm" | "none" = webnnSession.ok ? "webnn" : wasmSession.ok ? "wasm" : "none";
  const reason = webnnSession.ok
    ? "WebNN 可用"
    : wasmSession.ok
      ? "WebNN 不可用，WASM 可用"
      : "WebNN/WASM 均不可用";

  return {
    createdAt: new Date().toISOString(),
    env: {
      url: typeof globalThis !== "undefined" ? String((globalThis as unknown as { location?: { href?: string } }).location?.href ?? "worker") : "worker",
      secureContext: isSecure,
      crossOriginIsolated: (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? false,
      userAgent: ua,
      ortVersion: ortAll.env.versions.web,
    },
    checks,
    summary: {
      ok: webnnSession.ok || wasmSession.ok,
      effectiveRuntime,
      reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

async function disposeSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (typeof (entry.session as { release?: () => void }).release === "function") {
    (entry.session as { release: () => void }).release();
  }
  sessions.delete(sessionId);
}

async function disposeAll(): Promise<void> {
  for (const entry of sessions.values()) {
    if (typeof (entry.session as { release?: () => void }).release === "function") {
      (entry.session as { release: () => void }).release();
    }
  }
  sessions.clear();
  perModelLocks.clear();
}

// ---------------------------------------------------------------------------
// Comlink expose
// ---------------------------------------------------------------------------

const api: OnnxWorkerApi = {
  init,
  createSession,
  runInference,
  runOcrBatchDecode,
  runOcrSingleDecode,
  runOcrColorBatch,
  runOcrColorSingle,
  probeRuntime,
  disposeSession,
  disposeAll,
};

Comlink.expose(api);