import * as ortAll from "onnxruntime-web/all";
import { ensureOrtEnv } from "./onnx";

type CheckStatus = "pass" | "warn" | "fail" | "running" | "skip";

export type RuntimeCheckItem = {
  id: string;
  title: string;
  status: CheckStatus;
  code?: string;
  message: string;
  detail?: string;
};

export type RuntimeSelfCheckReport = {
  createdAt: string;
  env: {
    url: string;
    secureContext: boolean;
    crossOriginIsolated: boolean;
    userAgent: string;
    ortVersion?: string;
  };
  checks: RuntimeCheckItem[];
  summary: {
    ok: boolean;
    effectiveRuntime: "webnn" | "wasm" | "none";
    reason: string;
  };
};

type NavigatorWithMl = Navigator & {
  ml?: unknown;
};

function errText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function createSessionWithTimeout(
  modelUrl: string,
  options: Parameters<typeof ortAll.InferenceSession.create>[1],
  timeoutMs: number
): Promise<ortAll.InferenceSession> {
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

async function verifyWasmSession(modelUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await createSessionWithTimeout(
      modelUrl,
      {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all"
      },
      12000
    );
    if (typeof (session as { release?: () => void }).release === "function") {
      (session as { release: () => void }).release();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}

async function verifyWebnnSession(modelUrl: string): Promise<{ ok: boolean; error?: string }> {
  const attempts: Array<{ name: "webnn"; deviceType?: "gpu" | "cpu"; powerPreference?: "high-performance" } | "webnn"> = [
    { name: "webnn", deviceType: "gpu", powerPreference: "high-performance" },
    { name: "webnn", deviceType: "cpu" },
    "webnn"
  ];
  const errors: string[] = [];

  for (const ep of attempts) {
    try {
      const session = await createSessionWithTimeout(
        modelUrl,
        {
          executionProviders: [ep],
          graphOptimizationLevel: "all"
        },
        12000
      );
      if (typeof (session as { release?: () => void }).release === "function") {
        (session as { release: () => void }).release();
      }
      return { ok: true };
    } catch (error) {
      errors.push(errText(error));
    }
  }

  return { ok: false, error: errors.join(" || ") };
}

export async function runRuntimeSelfCheck(modelUrl = "/models/ocr.onnx"): Promise<RuntimeSelfCheckReport> {
  ensureOrtEnv();

  const checks: RuntimeCheckItem[] = [];
  const nav = (typeof navigator === "undefined" ? null : (navigator as NavigatorWithMl));
  const ua = nav?.userAgent ?? "unknown";

  checks.push({
    id: "env.security",
    title: "浏览器安全上下文",
    status: window.isSecureContext ? "pass" : "fail",
    code: window.isSecureContext ? undefined : "S001_INSECURE_CONTEXT",
    message: window.isSecureContext ? "当前页面为安全上下文" : "当前页面不是安全上下文，WebNN 可能不可用",
    detail: `isSecureContext=${String(window.isSecureContext)}, crossOriginIsolated=${String(window.crossOriginIsolated)}`
  });

  const hasMlApi = Boolean(nav?.ml);
  checks.push({
    id: "webnn.api",
    title: "WebNN API 可见性",
    status: hasMlApi ? "pass" : "fail",
    code: hasMlApi ? undefined : "B002_NO_WEBNN",
    message: hasMlApi ? "navigator.ml 可用" : "navigator.ml 不可用",
    detail: `ua=${ua}`
  });

  try {
    const response = await fetch(modelUrl, { method: "GET" });
    checks.push({
      id: "model.fetch",
      title: "诊断模型下载",
      status: response.ok ? "pass" : "fail",
      code: response.ok ? undefined : "O004_MODEL_FETCH_FAILED",
      message: response.ok ? "诊断模型可访问" : `诊断模型请求失败 (${response.status})`,
      detail: `url=${modelUrl}`
    });
  } catch (error) {
    checks.push({
      id: "model.fetch",
      title: "诊断模型下载",
      status: "fail",
      code: "O004_MODEL_FETCH_FAILED",
      message: "诊断模型下载异常",
      detail: errText(error)
    });
  }

  const webnnSession = hasMlApi ? await verifyWebnnSession(modelUrl) : { ok: false, error: "缺少 navigator.ml" };
  checks.push({
    id: "ort.webnn.session",
    title: "ORT WebNN 最小 Session",
    status: webnnSession.ok ? "pass" : "fail",
    code: webnnSession.ok ? undefined : "O002_ORT_WEBNN_BACKEND_UNAVAILABLE",
    message: webnnSession.ok ? "WebNN Session 创建成功" : "WebNN Session 创建失败",
    detail: webnnSession.error
  });

  const wasmSession = await verifyWasmSession(modelUrl);
  checks.push({
    id: "ort.wasm.session",
    title: "ORT WASM 对照 Session",
    status: wasmSession.ok ? "pass" : "fail",
    code: wasmSession.ok ? undefined : "O003_ORT_WASM_ASSET_MISSING",
    message: wasmSession.ok ? "WASM Session 创建成功" : "WASM Session 创建失败",
    detail: wasmSession.error
  });

  const webnnOk = webnnSession.ok;
  const wasmOk = wasmSession.ok;
  const effectiveRuntime: "webnn" | "wasm" | "none" = webnnOk ? "webnn" : wasmOk ? "wasm" : "none";
  const reason = webnnOk
    ? "WebNN 可用"
    : wasmOk
      ? "WebNN 不可用，当前可回退到 WASM"
      : "WebNN/WASM 均不可用，请检查资源与策略";

  return {
    createdAt: new Date().toISOString(),
    env: {
      url: window.location.href,
      secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      userAgent: ua,
      ortVersion: ortAll.env.versions.web
    },
    checks,
    summary: {
      ok: webnnOk || wasmOk,
      effectiveRuntime,
      reason
    }
  };
}
