import * as ortAll from "onnxruntime-web/all";
import * as Comlink from "comlink";
import type { InferenceSession } from "onnxruntime-common";
import type { OnnxSessionOptions } from "../runtime/onnxSessionOptions";
import { serializeOnnxSessionOptions } from "../runtime/onnxSessionOptions";
import { toErrorMessage } from "../shared/utils";
import { isContextLostRuntimeError, isCreateTimeoutError } from "../runtime/onnxTypes";
import type { RuntimeProvider, WebNnDeviceType } from "../runtime/onnxTypes";
import type {
  TensorTransport,
  WorkerSessionHandle,
  InferenceResult,
  OnnxWorkerApi,
  GpuDetectResult,
  PaddleGraphCaptureProbeOptions,
  PaddleGraphCaptureProbeResult,
} from "../runtime/onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "../runtime/selfCheck";
import { preprocessLetterboxGpu } from "./gpuPreprocess";
import { SerialInferenceQueue } from "./inferenceQueue";

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

function getWebGpuDevice(): GPUDevice | undefined {
  return (ortAll.env.webgpu as unknown as { device?: GPUDevice } | undefined)?.device;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSION_CREATE_TIMEOUT_MS = 30000;
const perModelLocks = new Map<string, Promise<void>>();
const inferenceQueue = new SerialInferenceQueue();
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
  preferred: RuntimeProvider[],
  experimentalSessionOptions?: OnnxSessionOptions
): Promise<WorkerSessionHandle> {
  return withPerModelLock(modelUrl, async () => {
    ensureOrtEnv();
    const normalized = preferred.filter((item, idx) => preferred.indexOf(item) === idx);
    const sessionOptionsKey = serializeOnnxSessionOptions(experimentalSessionOptions);
    const sessionId = `${modelKey}:${normalized.join(",")}:${sessionOptionsKey}`;

    // Check if session already cached
    const existing = sessions.get(sessionId);
    if (existing) {
      return {
        sessionId,
        provider: existing.provider,
        webnnDeviceType: existing.webnnDeviceType,
        inputNames: [...existing.session.inputNames],
        outputNames: [...existing.session.outputNames],
      };
    }

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
            const sessionOptions: Parameters<typeof ortAll.InferenceSession.create>[1] = {
              executionProviders: [ep],
              graphOptimizationLevel: "all",
            };
            if (provider === "webgpu" && experimentalSessionOptions) {
              if (typeof experimentalSessionOptions.enableGraphCapture === "boolean") {
                sessionOptions.enableGraphCapture = experimentalSessionOptions.enableGraphCapture;
              }
              if (experimentalSessionOptions.preferredOutputLocation !== undefined) {
                sessionOptions.preferredOutputLocation = experimentalSessionOptions.preferredOutputLocation;
              }
              if (experimentalSessionOptions.freeDimensionOverrides) {
                sessionOptions.freeDimensionOverrides = experimentalSessionOptions.freeDimensionOverrides;
              }
            }
            if (provider === "webgpu" && modelKey === "detector") {
              sessionOptions.preferredOutputLocation = "gpu-buffer";
            }
            const session = await createSessionWithTimeout(
              modelUrl,
              sessionOptions,
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

            sessions.set(sessionId, { session, provider, webnnDeviceType, modelUrl });

            return {
              sessionId,
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

async function tensorToTransport(tensor: ortAll.Tensor): Promise<TensorTransport> {
  // Handle GPU-buffer-located tensors (preferredOutputLocation: "gpu-buffer")
  if ((tensor as unknown as { location?: string }).location === "gpu-buffer") {
    const data = (await (tensor as unknown as { getData: () => Promise<Float32Array> }).getData()) as Float32Array | BigInt64Array | Uint8Array;
    return { data, dims: [...tensor.dims], type: tensor.type as "float32" | "int64" | "bool" };
  }
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
  return inferenceQueue.enqueue(async () => {
    const entry = sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session 不存在: ${sessionId}`);
    }

    const ortFeeds: Record<string, ortAll.Tensor> = {};
    for (const [name, transport] of Object.entries(feeds)) {
      ortFeeds[name] = transportToTensor(transport);
    }

    let outputs: Record<string, ortAll.Tensor> | undefined;
    try {
      try {
        outputs = await entry.session.run(ortFeeds);
      } catch (inferenceError) {
        const result: InferenceResult = {
          outputs: {},
          error: toErrorMessage(inferenceError),
        };
        return result;
      }

      const result: InferenceResult = {
        outputs: {},
      };
      const outTransferables: ArrayBuffer[] = [];
      for (const [name, tensor] of Object.entries(outputs)) {
        const transport = await tensorToTransport(tensor);
        result.outputs[name] = transport;
        if (transport.data instanceof Float32Array) {
          outTransferables.push(transport.data.buffer as ArrayBuffer);
        } else if (transport.data instanceof BigInt64Array) {
          outTransferables.push(transport.data.buffer as ArrayBuffer);
        }
      }

      return Comlink.transfer(result, outTransferables);
    } finally {
      for (const tensor of Object.values(outputs ?? {})) {
        tensor.dispose();
      }
      for (const tensor of Object.values(ortFeeds)) {
        tensor.dispose();
      }
    }
  });
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
// GPU-preprocessed detection inference
// ---------------------------------------------------------------------------

async function runDetectWithGpuPreprocess(
  sessionId: string,
  imageSource: ImageBitmap
): Promise<GpuDetectResult> {
  return inferenceQueue.enqueue(async () => {
    const entry = sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session 不存在: ${sessionId}`);
    }
    if (entry.provider !== "webgpu") {
      throw new Error(`GPU 预处理仅支持 WebGPU EP，当前: ${entry.provider}`);
    }

    let inputTensor: ortAll.Tensor | undefined;
    let outputs: Record<string, ortAll.Tensor> | undefined;
    try {
      const inputSize = 1024;
      const preprocessed = await preprocessLetterboxGpu(imageSource, inputSize);
      inputTensor = preprocessed.tensor;

      const inputName = entry.session.inputNames[0] ?? "images";
      const feeds: Record<string, ortAll.Tensor> = { [inputName]: inputTensor };
      outputs = await entry.session.run(feeds);

      const result: GpuDetectResult = {
        outputs: {},
        ratio: preprocessed.params.ratio,
        unpaddedWidth: preprocessed.params.unpaddedWidth,
        unpaddedHeight: preprocessed.params.unpaddedHeight,
      };
      const outTransferables: ArrayBuffer[] = [];

      for (const [name, outTensor] of Object.entries(outputs)) {
        let data: Float32Array | BigInt64Array | Uint8Array;
        if (outTensor.location === "gpu-buffer") {
          data = (await outTensor.getData()) as Float32Array;
        } else {
          data = outTensor.data as Float32Array | BigInt64Array | Uint8Array;
        }
        const transport: TensorTransport = { data, dims: [...outTensor.dims], type: outTensor.type as "float32" | "int64" | "bool" };
        result.outputs[name] = transport;
        if (data instanceof Float32Array) {
          outTransferables.push(data.buffer as ArrayBuffer);
        } else if (data instanceof BigInt64Array) {
          outTransferables.push(data.buffer as ArrayBuffer);
        }
      }

      return Comlink.transfer(result, outTransferables);
    } finally {
      for (const tensor of Object.values(outputs ?? {})) {
        tensor.dispose();
      }
      inputTensor?.dispose();
      imageSource.close();
    }
  });
}

async function probePaddleGraphCapture(
  options: PaddleGraphCaptureProbeOptions
): Promise<PaddleGraphCaptureProbeResult> {
  ensureOrtEnv();
  const inputWidth = Math.max(1, Math.round(options.inputWidth ?? 320));
  const batchSize = Math.max(1, Math.round(options.batchSize ?? 1));
  const classCount = Math.max(1, Math.round(options.classCount ?? 18710));
  const runs = Math.max(1, Math.round(options.runs ?? 3));
  const inputDims = [batchSize, 3, 48, inputWidth];
  const outputDims = [batchSize, Math.max(1, Math.floor(inputWidth / 8)), classCount];
  const inputBytes = inputDims.reduce((size, dim) => size * dim, 4);
  const outputBytes = outputDims.reduce((size, dim) => size * dim, 4);
  const baseResult = {
    ok: false,
    modelUrl: options.modelUrl,
    inputDims,
    outputDims,
    inputBytes,
    outputBytes,
    runMs: [],
  };

  let session: InferenceSession | null = null;
  let inputBuffer: GPUBuffer | null = null;
  let outputBuffer: GPUBuffer | null = null;
  let inputTensor: ortAll.Tensor | null = null;
  let outputTensor: ortAll.Tensor | null = null;
  let createSessionMs: number | undefined;
  try {
    const createT0 = performance.now();
    session = await createSessionWithTimeout(
      options.modelUrl,
      {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        enableGraphCapture: true,
        preferredOutputLocation: "gpu-buffer",
        freeDimensionOverrides: {
          "DynamicDimension.0": batchSize,
          "DynamicDimension.1": inputWidth,
        },
      },
      SESSION_CREATE_TIMEOUT_MS
    );
    createSessionMs = performance.now() - createT0;

    const device = getWebGpuDevice();
    if (!device) {
      throw new Error("ort.env.webgpu.device 不可用");
    }
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    inputBuffer = device.createBuffer({ size: inputBytes, usage });
    outputBuffer = device.createBuffer({ size: outputBytes, usage });
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) {
      throw new Error("PaddleOCR 模型缺少输入或输出名称");
    }
    inputTensor = ortAll.Tensor.fromGpuBuffer(inputBuffer, {
      dataType: "float32",
      dims: inputDims,
    });
    outputTensor = ortAll.Tensor.fromGpuBuffer(outputBuffer, {
      dataType: "float32",
      dims: outputDims,
    });
    const feeds = { [inputName]: inputTensor };
    const fetches = { [outputName]: outputTensor };
    const activeSession = session;
    const runMs = await inferenceQueue.enqueue(async () => {
      const durations: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const runT0 = performance.now();
        await activeSession.run(feeds, fetches);
        await device.queue.onSubmittedWorkDone();
        durations.push(performance.now() - runT0);
      }
      return durations;
    });
    return {
      ...baseResult,
      ok: true,
      createSessionMs,
      runMs,
    };
  } catch (error) {
    return {
      ...baseResult,
      createSessionMs,
      error: toErrorMessage(error),
    };
  } finally {
    if (session) {
      await session.release();
    }
    inputTensor?.dispose();
    outputTensor?.dispose();
    inputBuffer?.destroy();
    outputBuffer?.destroy();
  }
}

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

async function disposeSession(sessionId: string): Promise<void> {
  await inferenceQueue.enqueue(async () => {
    const releaseEntry = async (key: string, entry: { session: InferenceSession }): Promise<void> => {
      sessions.delete(key);
      await entry.session.release();
    };

    const exact = sessions.get(sessionId);
    if (exact) {
      await releaseEntry(sessionId, exact);
    }
    const prefix = `${sessionId}:`;
    for (const [key, entry] of [...sessions.entries()]) {
      if (key.startsWith(prefix)) {
        await releaseEntry(key, entry);
      }
    }
  });
}

async function disposeAll(): Promise<void> {
  await inferenceQueue.enqueue(async () => {
    const entries = [...sessions.values()];
    sessions.clear();
    perModelLocks.clear();
    for (const entry of entries) {
      await entry.session.release();
    }
  });
}

// ---------------------------------------------------------------------------
// Comlink expose
// ---------------------------------------------------------------------------

const api: OnnxWorkerApi = {
  init,
  createSession,
  runInference,
  probeRuntime,
  probePaddleGraphCapture,
  runDetectWithGpuPreprocess,
  disposeSession,
  disposeAll,
};

Comlink.expose(api);
