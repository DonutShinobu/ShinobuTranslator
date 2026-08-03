import * as Comlink from "comlink";
import type { RuntimeProvider } from "./onnxTypes";
import type { OnnxSessionOptions } from "./onnxSessionOptions";
import type {
  TensorTransport,
  WorkerSessionHandle,
  InferenceResult,
  OnnxWorkerApi,
  GpuDetectResult,
  PaddleGraphCaptureProbeOptions,
  PaddleGraphCaptureProbeResult,
} from "./onnxWorkerTypes";
import type { RuntimeSelfCheckReport } from "./selfCheck";
import {
  recordModelRuntimeEvent as recordPerfRuntimeEvent,
  recordModelRuntimeWorkerCall as recordPerfWorkerCall,
} from './performanceObserver';
import {
  serializeRuntimeError,
  type SerializedRuntimeError,
} from './errorMessage';

export type WorkerBootstrapPolicy = 'direct-only' | 'direct-then-blob';

export type WorkerBootstrapAttempt = {
  mode: 'direct' | 'blob';
  scriptUrl: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'failed';
  error?: SerializedRuntimeError;
};

// ---------------------------------------------------------------------------
// Worker singleton — created once, reused across pipeline calls.
//
// The production pipeline host always creates the Worker directly from
// the extension URL. Blob fallback exists only for HTTP development and
// benchmark pages, where it is not subject to a website's production CSP.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let proxy: Comlink.Remote<OnnxWorkerApi> | null = null;
let workerPromise: Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> | null = null;
let webBootstrapConfig: {
  scriptUrl: string;
  ortPath: string;
  policy: WorkerBootstrapPolicy;
} | null = null;
const sessionProviders = new Map<string, RuntimeProvider>();
const sessionModels = new Map<string, string>();

export function configureOnnxWorkerBootstrap(config: {
  scriptUrl: string;
  ortPath: string;
  policy: WorkerBootstrapPolicy;
}): void {
  if (worker || workerPromise) {
    throw new Error("ONNX Worker 已启动，不能再修改启动地址");
  }
  webBootstrapConfig = {
    scriptUrl: config.scriptUrl,
    ortPath: config.ortPath,
    policy: config.policy,
  };
}

export class WorkerBootstrapError extends Error {
  readonly code = "WORKER_BOOTSTRAP_FAILED";

  constructor(readonly attempts: WorkerBootstrapAttempt[], cause?: unknown) {
    const detail = attempts
      .map((attempt) => `${attempt.mode}: ${attempt.status}${attempt.error ? ` (${attempt.error.message})` : ""}`)
      .join(" | ");
    super(`ONNX Worker 启动失败: ${detail || "没有可用启动方式"}`, cause === undefined ? undefined : { cause });
    this.name = "WorkerBootstrapError";
  }
}

function tensorByteLength(tensor: TensorTransport): number {
  return tensor.data.byteLength;
}

function tensorRecordByteLength(tensors: Record<string, TensorTransport>): number {
  return Object.values(tensors).reduce((sum, tensor) => sum + tensorByteLength(tensor), 0);
}

function gpuDetectOutputBytes(result: GpuDetectResult): number {
  return tensorRecordByteLength(result.outputs);
}

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
  let workerErrorListener: ((event: ErrorEvent) => void) | null = null;
  const workerError = new Promise<never>((_resolve, reject) => {
    workerErrorListener = (event: ErrorEvent) => {
      const detail = [
        event.message || `${label} failed to load`,
        event.filename ? `source=${event.filename}` : "",
        event.lineno ? `line=${event.lineno}:${event.colno ?? 0}` : "",
      ].filter(Boolean).join(" | ");
      reject(new Error(detail, event.error === undefined ? undefined : { cause: event.error }));
    };
    candidate.addEventListener("error", workerErrorListener, { once: true });
  });
  try {
    await withTimeout(Promise.race([candidateProxy.init(ortPath), workerError]), 10000, `${label} init`);
    return candidateProxy;
  } catch (error) {
    candidate.terminate();
    throw error;
  } finally {
    if (workerErrorListener) candidate.removeEventListener("error", workerErrorListener);
  }
}

async function initBlobWorker(scriptUrl: string, ortPath: string): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`Worker 脚本请求失败: HTTP ${response.status} ${response.statusText}`);
  }
  const scriptText = await response.text();
  if (!scriptText.trim()) {
    throw new Error("Worker 脚本响应为空");
  }
  const blob = new Blob([scriptText], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const candidate = new Worker(blobUrl, { type: "module" });
    const candidateProxy = await initWorker(candidate, ortPath, "blob HTTP Worker");
    return { worker: candidate, proxy: candidateProxy };
  } finally {
    // Keep the URL alive until the module Worker has completed initialization.
    URL.revokeObjectURL(blobUrl);
  }
}

async function runBootstrapAttempt(
  attempts: WorkerBootstrapAttempt[],
  mode: WorkerBootstrapAttempt["mode"],
  scriptUrl: string,
  bootstrap: () => Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }>,
): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  recordPerfRuntimeEvent({
    kind: "worker-bootstrap-attempt",
    message: `开始 ONNX Worker 启动尝试: ${mode}`,
    data: { mode, scriptUrl },
  });
  try {
    const result = await bootstrap();
    const attempt: WorkerBootstrapAttempt = {
      mode,
      scriptUrl,
      startedAt: startedAtIso,
      durationMs: performance.now() - startedAt,
      status: "success",
    };
    attempts.push(attempt);
    recordPerfRuntimeEvent({
      kind: "worker-bootstrap-complete",
      message: `ONNX Worker 启动成功: ${mode}`,
      data: { attempt },
    });
    return result;
  } catch (error) {
    const attempt: WorkerBootstrapAttempt = {
      mode,
      scriptUrl,
      startedAt: startedAtIso,
      durationMs: performance.now() - startedAt,
      status: "failed",
      error: serializeRuntimeError(error, 'WORKER_BOOTSTRAP_FAILED'),
    };
    attempts.push(attempt);
    recordPerfRuntimeEvent({
      kind: "worker-bootstrap-attempt",
      message: `ONNX Worker 启动失败: ${mode}`,
      data: { attempt },
      error,
    });
    throw error;
  }
}

async function bootstrapWorker(): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  const attempts: WorkerBootstrapAttempt[] = [];
  if (!webBootstrapConfig) {
    throw new WorkerBootstrapError(
      attempts,
      new Error('必须显式配置 ONNX Worker URL、ORT 路径和启动策略'),
    );
  }
  const rawScriptUrl = webBootstrapConfig.scriptUrl;
  const rawOrtPath = webBootstrapConfig.ortPath;
  const scriptUrl = rawScriptUrl.startsWith("/")
    ? new URL(rawScriptUrl, globalThis.location?.href).toString()
    : rawScriptUrl;
  const ortPath = rawOrtPath.startsWith("/")
    ? new URL(rawOrtPath, globalThis.location?.href).toString()
    : rawOrtPath;

  let directError: unknown = null;
  try {
    return await runBootstrapAttempt(attempts, 'direct', scriptUrl, async () => {
      const candidate = new Worker(scriptUrl, { type: 'module' });
      const candidateProxy = await initWorker(candidate, ortPath, 'direct Worker');
      return { worker: candidate, proxy: candidateProxy };
    });
  } catch (error) {
    directError = error;
  }
  if (webBootstrapConfig.policy === 'direct-only') {
    throw new WorkerBootstrapError(attempts, directError);
  }
  if (!/^https?:\/\//iu.test(scriptUrl)) {
    throw new WorkerBootstrapError(
      attempts,
      new Error('Blob fallback 只允许 HTTP(S) Worker URL'),
    );
  }
  try {
    return await runBootstrapAttempt(
      attempts,
      'blob',
      scriptUrl,
      () => initBlobWorker(scriptUrl, ortPath),
    );
  } catch (error) {
    throw new WorkerBootstrapError(
      attempts,
      new AggregateError([directError, error], 'Worker 启动方式均失败'),
    );
  }
}

async function ensureWorker(): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }> {
  if (worker && proxy) return { worker, proxy };
  if (workerPromise) return workerPromise;
  workerPromise = bootstrapWorker()
    .then((result) => {
      worker = result.worker;
      proxy = result.proxy;
      return result;
    })
    .finally(() => {
      workerPromise = null;
    });
  return workerPromise;
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
  preferred: RuntimeProvider[],
  sessionOptions?: OnnxSessionOptions
): Promise<WorkerSessionHandle> {
  const startedAt = performance.now();
  let handle: WorkerSessionHandle | null = null;
  let failure: unknown = null;
  try {
    handle = await (await getProxy()).createSession(modelKey, modelUrl, preferred, sessionOptions);
    sessionProviders.set(handle.sessionId, handle.provider);
    sessionModels.set(handle.sessionId, modelKey);
    return handle;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    recordPerfWorkerCall({
      kind: "createSession",
      model: modelKey,
      provider: handle?.provider,
      startedAt,
      durationMs: performance.now() - startedAt,
      error: failure instanceof Error ? failure.message : failure === null ? undefined : String(failure),
    });
  }
}

export async function runInference(
  sessionId: string,
  feeds: Record<string, TensorTransport>
): Promise<InferenceResult> {
  const startedAt = performance.now();
  let result: InferenceResult | null = null;
  let failure: unknown = null;
  try {
    result = await (await getProxy()).runInference(sessionId, feeds);
    // Worker 推理失败时不抛异常，通过 InferenceResult.error 返回错误信息。
    // 调用者需要自行检查 error 字段。
    if (result.error) {
      failure = new Error(result.error);
      recordPerfRuntimeEvent({
        kind: "inference-failure",
        model: sessionModels.get(sessionId) ?? sessionId,
        provider: sessionProviders.get(sessionId),
        message: `ONNX 推理失败: ${sessionModels.get(sessionId) ?? sessionId}`,
        error: failure,
      });
    }
    return result;
  } catch (error) {
    failure = error;
    recordPerfRuntimeEvent({
      kind: "inference-failure",
      model: sessionModels.get(sessionId) ?? sessionId,
      provider: sessionProviders.get(sessionId),
      message: `ONNX 推理调用异常: ${sessionModels.get(sessionId) ?? sessionId}`,
      error,
    });
    throw error;
  } finally {
    recordPerfWorkerCall({
      kind: "runInference",
      model: sessionModels.get(sessionId) ?? sessionId,
      provider: sessionProviders.get(sessionId),
      inputBytes: tensorRecordByteLength(feeds),
      outputBytes: result ? tensorRecordByteLength(result.outputs) : undefined,
      startedAt,
      durationMs: performance.now() - startedAt,
      error: failure instanceof Error ? failure.message : failure === null ? undefined : String(failure),
    });
  }
}

export async function probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport> {
  const startedAt = performance.now();
  try {
    return await (await getProxy()).probeRuntime(modelUrl);
  } finally {
    recordPerfWorkerCall({
      kind: "probeRuntime",
      model: modelUrl,
      startedAt,
      durationMs: performance.now() - startedAt,
    });
  }
}

export async function probePaddleGraphCapture(
  options: PaddleGraphCaptureProbeOptions
): Promise<PaddleGraphCaptureProbeResult> {
  const startedAt = performance.now();
  let result: PaddleGraphCaptureProbeResult | null = null;
  try {
    result = await (await getProxy()).probePaddleGraphCapture(options);
    return result;
  } finally {
    recordPerfWorkerCall({
      kind: "probePaddleGraphCapture",
      model: options.modelUrl,
      inputBytes: result?.inputBytes,
      outputBytes: result?.outputBytes,
      startedAt,
      durationMs: performance.now() - startedAt,
    });
  }
}

export async function runDetectWithGpuPreprocess(
  sessionId: string,
  imageSource: ImageBitmap
): Promise<GpuDetectResult> {
  const proxy = await getProxy();
  const startedAt = performance.now();
  let result: GpuDetectResult | null = null;
  let failure: unknown = null;
  try {
    result = await proxy.runDetectWithGpuPreprocess(
      sessionId,
      Comlink.transfer(imageSource, [imageSource])
    );
    return result;
  } catch (error) {
    failure = error;
    recordPerfRuntimeEvent({
      kind: "inference-failure",
      model: sessionModels.get(sessionId) ?? sessionId,
      provider: sessionProviders.get(sessionId),
      message: `GPU 检测推理调用异常: ${sessionModels.get(sessionId) ?? sessionId}`,
      error,
    });
    throw error;
  } finally {
    recordPerfWorkerCall({
      kind: "runDetectWithGpuPreprocess",
      model: sessionModels.get(sessionId) ?? sessionId,
      provider: sessionProviders.get(sessionId),
      outputBytes: result ? gpuDetectOutputBytes(result) : undefined,
      startedAt,
      durationMs: performance.now() - startedAt,
      error: failure instanceof Error ? failure.message : failure === null ? undefined : String(failure),
    });
  }
}

export async function disposeSession(sessionId: string): Promise<void> {
  await (await getProxy()).disposeSession(sessionId);
  sessionProviders.delete(sessionId);
  sessionModels.delete(sessionId);
}

export async function disposeAll(): Promise<void> {
  const currentWorker = worker;
  const currentProxy = proxy;
  worker = null;
  proxy = null;
  workerPromise = null;
  sessionProviders.clear();
  sessionModels.clear();
  if (!currentWorker || !currentProxy) return;
  try {
    await currentProxy.disposeAll();
  } finally {
    try {
      currentProxy[Comlink.releaseProxy]();
    } catch {
      // Older Comlink proxies may not expose releaseProxy.
    }
    currentWorker.terminate();
  }
}
