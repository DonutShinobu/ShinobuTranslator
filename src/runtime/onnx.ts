import * as ortAll from "onnxruntime-web/all";
import type { InferenceSession } from "onnxruntime-common";

export type OrtxSession = InferenceSession;
export type RuntimeProvider = "webnn" | "webgpu" | "wasm";
export type WebNnDeviceType = "gpu" | "cpu" | "default";

export type SessionHandle = {
  session: OrtxSession;
  provider: RuntimeProvider;
  webnnDeviceType?: WebNnDeviceType;
};

let envInitialized = false;
const perModelLocks = new Map<string, Promise<void>>();
const SESSION_CREATE_TIMEOUT_MS = 30000;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function probeWebNnAvailability(): { available: boolean; reason?: string } {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & {
    ml?: unknown;
  });

  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { available: false, reason: "当前页面不是安全上下文，WebNN 不可用" };
  }

  if (!nav?.ml) {
    return { available: false, reason: "navigator.ml 不可用" };
  }

  return { available: true };
}

function getExecutionProviderAttempts(provider: RuntimeProvider): InferenceSession.ExecutionProviderConfig[] {
  if (provider === "webnn") {
    return [
      { name: "webnn", deviceType: "gpu", powerPreference: "high-performance" },
      { name: "webnn", deviceType: "cpu" },
      "webnn"
    ];
  }
  return [provider];
}

function isWebNnEpObject(
  ep: InferenceSession.ExecutionProviderConfig
): ep is Exclude<InferenceSession.ExecutionProviderConfig, string> {
  return typeof ep === "object" && ep !== null && "name" in ep && ep.name === "webnn";
}

function inferWebNnDeviceType(ep: InferenceSession.ExecutionProviderConfig): WebNnDeviceType {
  if (!isWebNnEpObject(ep)) {
    return "default";
  }
  if ("deviceType" in ep && ep.deviceType === "gpu") {
    return "gpu";
  }
  if ("deviceType" in ep && ep.deviceType === "cpu") {
    return "cpu";
  }
  return "default";
}

function isContextLostError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("context is lost") || (lower.includes("mlgraphbuilder") && lower.includes("invalidstateerror"));
}

export function isContextLostRuntimeError(error: unknown): boolean {
  return isContextLostError(toErrorMessage(error));
}

function isCreateTimeoutError(message: string): boolean {
  return message.includes("Session 创建超时");
}

async function createSessionWithTimeout(
  modelUrl: string,
  options: Parameters<typeof ortAll.InferenceSession.create>[1],
  timeoutMs: number
): Promise<OrtxSession> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      ortAll.InferenceSession.create(modelUrl, options),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`Session 创建超时(${timeoutMs}ms)`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  }
}

async function withPerModelLock<T>(modelUrl: string, task: () => Promise<T>): Promise<T> {
  const previous = perModelLocks.get(modelUrl) ?? Promise.resolve();
  let release: () => void = () => undefined;
  perModelLocks.set(modelUrl, new Promise<void>((resolve) => {
    release = resolve;
  }));
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

export function ensureOrtEnv(): void {
  if (envInitialized) {
    return;
  }

  const hwThreads =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 1;
  const canUseWasmThreads =
    typeof window !== "undefined" && window.isSecureContext && window.crossOriginIsolated;
  const wasmThreads = canUseWasmThreads ? Math.max(1, Math.min(8, hwThreads)) : 1;

  ortAll.env.wasm.wasmPaths = "/node_modules/onnxruntime-web/dist/";
  ortAll.env.wasm.numThreads = wasmThreads;
  ortAll.env.wasm.proxy = false;

  if (ortAll.env.webgpu) {
    ortAll.env.webgpu.powerPreference = "high-performance";
  }

  if (!canUseWasmThreads && hwThreads > 1) {
    console.warn("[onnx] 当前非 crossOriginIsolated，WASM 线程数被限制为 1。可通过 COOP/COEP 启用多线程。");
  }

  envInitialized = true;
}

export async function createSession(modelUrl: string, preferred: RuntimeProvider[] = ["webnn", "wasm"]): Promise<SessionHandle> {
  return withPerModelLock(modelUrl, async () => {
    ensureOrtEnv();

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
        if (abortProvider) {
          break;
        }
        const maxAttempts = provider === "webnn" ? 2 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          try {
            const session = await createSessionWithTimeout(
              modelUrl,
              {
                executionProviders: [ep],
                graphOptimizationLevel: "all"
              },
              SESSION_CREATE_TIMEOUT_MS
            );

            if (provider === "wasm") {
              if (providerErrors.webnn) {
                console.warn(`[onnx] WebNN 不可用，回退到 WASM: ${providerErrors.webnn}`);
              }
              if (providerErrors.webgpu) {
                console.warn(`[onnx] WebGPU 不可用，回退到 WASM: ${providerErrors.webgpu}`);
              }
            }

            return {
              session,
              provider,
              webnnDeviceType: provider === "webnn" ? inferWebNnDeviceType(ep) : undefined
            };
          } catch (error) {
            const message = toErrorMessage(error);
            attemptErrors.push(message);
            if (isCreateTimeoutError(message)) {
              abortProvider = true;
              break;
            }
            if (provider === "webnn" && attempt + 1 < maxAttempts && isContextLostError(message)) {
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
      .filter((provider) => providerErrors[provider as RuntimeProvider])
      .map((provider) => `${provider}: ${providerErrors[provider as RuntimeProvider]}`)
      .join(" | ");

    throw new Error(`ONNX Session 创建失败: ${detail || "未知错误"}`);
  });
}
