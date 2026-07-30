import * as ortAll from "onnxruntime-web/all";

export type { RuntimeProvider, WebNnDeviceType } from "./onnxTypes";
export { isContextLostRuntimeError } from "./onnxTypes";

let envInitialized = false;
let ortAssetPath: string | null = null;

export function configureOrtAssetPath(path: string): void {
  if (envInitialized) {
    throw new Error("ONNX Runtime 已初始化，不能再修改 ORT 资源地址");
  }
  ortAssetPath = path;
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

  if (!ortAssetPath) {
    throw new Error("ORT 资源地址必须由组合根注入");
  }
  ortAll.env.wasm.wasmPaths = ortAssetPath;
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
