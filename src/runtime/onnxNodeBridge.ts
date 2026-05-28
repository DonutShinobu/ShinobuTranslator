/**
 * Node.js ONNX Bridge — direct calls to onnxruntime-node (CUDA EP / CPU).
 *
 * This module implements the same exported function set as onnxWorkerBridge.ts
 * but without Comlink/Web Worker. All sessions live in-process, so there is
 * no sessionId indirection or TensorTransport serialization needed for the
 * internal session.run() call.
 *
 * onnxruntime-node is loaded via dynamic import because it is an optional
 * dependency that only exists in Node environments. Browser builds must not
 * attempt to resolve it.
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
  GpuDetectResult,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";
import {
  decodeBatchAutoregressive,
  decodeAutoregressiveWithBeam,
} from "../pipeline/ocr/decodeAutoregressive";
import { decodeTokenColorsBatch, decodeTokenColors } from "../pipeline/ocr/color";
import type { OcrInputData } from "../pipeline/ocr/preprocess";
import { toErrorMessage } from "../shared/utils";

// ---------------------------------------------------------------------------
// Dynamic import — onnxruntime-node (optional, Node-only)
// ---------------------------------------------------------------------------

type OrtNode = typeof import("onnxruntime-node");
type OrtInferenceSession = import("onnxruntime-node").InferenceSession;
type OrtTensor = import("onnxruntime-node").Tensor;

let ortNode: OrtNode | null = null;

async function getOrtNode(): Promise<OrtNode> {
  if (!ortNode) {
    ortNode = await import("onnxruntime-node");
  }
  return ortNode;
}

// ---------------------------------------------------------------------------
// Session management — in-process Map, no Worker boundary
// ---------------------------------------------------------------------------

const sessions = new Map<string, {
  session: OrtInferenceSession;
  provider: RuntimeProvider;
  modelPath: string;
}>();

const SESSION_CREATE_TIMEOUT_MS = 60000;

async function createSessionWithTimeout(
  modelPath: string,
  options: { executionProviders: string[] },
  timeoutMs: number
): Promise<OrtInferenceSession> {
  const ort = await getOrtNode();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      ort.InferenceSession.create(modelPath, options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Session 创建超时(${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function tryCreateSession(
  modelPath: string,
  executionProviders: string[]
): Promise<{ session: OrtInferenceSession; provider: RuntimeProvider } | null> {
  try {
    const session = await createSessionWithTimeout(modelPath, {
      executionProviders,
    }, SESSION_CREATE_TIMEOUT_MS);

    // Determine which EP actually succeeded by checking session options
    // onnxruntime-node doesn't expose the active EP directly; we infer
    // from the attempt order — first successful provider is the winner.
    const provider: RuntimeProvider = executionProviders[0] as RuntimeProvider;
    return { session, provider };
  } catch (error) {
    return null;
  }
}

export async function createSession(
  modelKey: string,
  modelUrl: string,
  preferred: RuntimeProvider[]
): Promise<WorkerSessionHandle> {
  // In Node context, modelUrl is a local file path (absolute).
  const existing = sessions.get(modelKey);
  if (existing) {
    return {
      sessionId: modelKey,
      provider: existing.provider,
      inputNames: [...existing.session.inputNames],
      outputNames: [...existing.session.outputNames],
    };
  }

  // Build EP order: prefer CUDA, fall back to CPU.
  // Node bridge only knows cuda and cpu; other providers are ignored.
  const epOrder: string[] = [];
  for (const p of preferred) {
    if (p === "cuda") {
      epOrder.push("cuda");
    }
  }
  // Always add cpu as fallback
  if (!epOrder.includes("cpu")) {
    epOrder.push("cpu");
  }

  // Try each EP configuration
  const errors: string[] = [];
  for (const ep of epOrder) {
    const result = await tryCreateSession(modelUrl, [ep]);
    if (result) {
      sessions.set(modelKey, { session: result.session, provider: result.provider, modelPath: modelUrl });
      if (result.provider === "cpu" && preferred.includes("cuda")) {
        console.warn("[onnxNodeBridge] CUDA 不可用，回退到 CPU");
      }
      return {
        sessionId: modelKey,
        provider: result.provider,
        inputNames: [...result.session.inputNames],
        outputNames: [...result.session.outputNames],
      };
    }
    errors.push(`${ep}: Session 创建失败`);
  }

  throw new Error(`ONNX Node Session 创建失败: ${errors.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// Tensor conversion — TensorTransport <-> ort.Tensor
// ---------------------------------------------------------------------------

async function transportToOrtTensor(transport: TensorTransport): Promise<OrtTensor> {
  const ort = await getOrtNode();
  if (transport.type === "float32") {
    return new ort.Tensor("float32", transport.data as Float32Array, transport.dims);
  }
  if (transport.type === "int64") {
    return new ort.Tensor("int64", transport.data as BigInt64Array, transport.dims);
  }
  if (transport.type === "bool") {
    return new ort.Tensor("bool", transport.data as Uint8Array, transport.dims);
  }
  throw new Error(`不支持的 transport 类型: ${transport.type}`);
}

function ortTensorToTransport(tensor: OrtTensor): TensorTransport {
  if (tensor.data instanceof Float32Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "float32" };
  }
  if (tensor.data instanceof BigInt64Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "int64" };
  }
  if (tensor.data instanceof Uint8Array) {
    return { data: tensor.data, dims: [...tensor.dims], type: "bool" };
  }
  // Fallback: convert typed-array-like data to Float32Array
  const numeric = tensor.data as ArrayLike<number>;
  return {
    data: new Float32Array(numeric),
    dims: [...tensor.dims],
    type: "float32",
  };
}

// ---------------------------------------------------------------------------
// Inference — direct session.run(), no Worker boundary
// ---------------------------------------------------------------------------

export async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const ortFeeds: Record<string, OrtTensor> = {};
  for (const [name, transport] of Object.entries(feeds)) {
    ortFeeds[name] = await transportToOrtTensor(transport);
  }

  let outputs: Record<string, OrtTensor>;
  try {
    outputs = await entry.session.run(ortFeeds);
  } catch (inferenceError) {
    return {
      outputs: {},
      error: toErrorMessage(inferenceError),
    };
  }

  const result: InferenceResult = { outputs: {} };
  for (const [name, tensor] of Object.entries(outputs)) {
    result.outputs[name] = ortTensorToTransport(tensor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// OCR batch decode — full AR loop in-process
// ---------------------------------------------------------------------------

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
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const ort = await getOrtNode();
  const imageTensor = new ort.Tensor("float32", imageData, imageDims);
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

export async function runOcrColorBatch(
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
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`Session 不存在: ${sessionId}`);
  }

  const ort = await getOrtNode();
  const imageTensor = new ort.Tensor("float32", imageData, imageDims);
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
// Runtime probe — check CUDA availability
// ---------------------------------------------------------------------------

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  // In Node context, modelUrl is a local file path.
  const checks: import("./selfCheck").RuntimeCheckItem[] = [];

  // Check 1: file exists
  const fs = await import("fs");
  const fileExists = fs.existsSync(modelUrl);
  checks.push({
    id: "model.file",
    title: "诊断模型文件",
    status: fileExists ? "pass" : "fail",
    code: fileExists ? undefined : "O004_MODEL_FILE_MISSING",
    message: fileExists ? "诊断模型文件可访问" : `诊断模型文件不存在: ${modelUrl}`,
    detail: `path=${modelUrl}`,
  });

  // Check 2: CUDA session creation
  let cudaOk = false;
  let cudaError: string | undefined;
  if (fileExists) {
    try {
      const result = await tryCreateSession(modelUrl, ["cuda"]);
      if (result) {
        cudaOk = true;
        // Dispose probe session immediately
        if (typeof (result.session as { release?: () => void }).release === "function") {
          (result.session as { release: () => void }).release();
        }
      } else {
        cudaError = "CUDA Session 创建失败";
      }
    } catch (error) {
      cudaError = toErrorMessage(error);
    }
  } else {
    cudaError = "模型文件不存在，无法测试 CUDA";
  }
  checks.push({
    id: "ort.cuda.session",
    title: "ORT CUDA Session",
    status: cudaOk ? "pass" : "fail",
    code: cudaOk ? undefined : "O005_ORT_CUDA_UNAVAILABLE",
    message: cudaOk ? "CUDA Session 创建成功" : "CUDA Session 创建失败",
    detail: cudaError,
  });

  // Check 3: CPU session creation (baseline)
  let cpuOk = false;
  let cpuError: string | undefined;
  if (fileExists) {
    try {
      const result = await tryCreateSession(modelUrl, ["cpu"]);
      if (result) {
        cpuOk = true;
        if (typeof (result.session as { release?: () => void }).release === "function") {
          (result.session as { release: () => void }).release();
        }
      } else {
        cpuError = "CPU Session 创建失败";
      }
    } catch (error) {
      cpuError = toErrorMessage(error);
    }
  } else {
    cpuError = "模型文件不存在，无法测试 CPU";
  }
  checks.push({
    id: "ort.cpu.session",
    title: "ORT CPU 对照 Session",
    status: cpuOk ? "pass" : "fail",
    code: cpuOk ? undefined : "O003_ORT_CPU_SESSION_FAILED",
    message: cpuOk ? "CPU Session 创建成功" : "CPU Session 创建失败",
    detail: cpuError,
  });

  const effectiveRuntime: "cuda" | "cpu" | "none" = cudaOk ? "cuda" : cpuOk ? "cpu" : "none";
  const reason = cudaOk
    ? "CUDA 可用"
    : cpuOk
      ? "CUDA 不可用，CPU 可用"
      : "CUDA/CPU 均不可用";

  const ort = await getOrtNode();
  return {
    createdAt: new Date().toISOString(),
    env: {
      url: "node",
      secureContext: false,
      crossOriginIsolated: false,
      userAgent: `Node.js ${process.version}`,
      ortVersion: ort.env.versions.node,
    },
    checks,
    summary: {
      ok: cudaOk || cpuOk,
      effectiveRuntime,
      reason,
    },
  };
}

// ---------------------------------------------------------------------------
// GPU-preprocessed detection — not supported in Node (no WebGPU)
// ---------------------------------------------------------------------------

export async function runDetectWithGpuPreprocess(
  _sessionId: string,
  _imageSource: ImageBitmap,
): Promise<GpuDetectResult> {
  throw new Error("GPU 预处理仅在浏览器 WebGPU 环境下可用");
}

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

export async function disposeSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (typeof (entry.session as { release?: () => void }).release === "function") {
    (entry.session as { release: () => void }).release();
  }
  sessions.delete(sessionId);
}

export async function disposeAll(): Promise<void> {
  for (const entry of sessions.values()) {
    if (typeof (entry.session as { release?: () => void }).release === "function") {
      (entry.session as { release: () => void }).release();
    }
  }
  sessions.clear();
}