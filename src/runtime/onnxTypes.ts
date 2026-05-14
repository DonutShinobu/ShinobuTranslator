import { toErrorMessage } from "../shared/utils";

export type RuntimeProvider = "webnn" | "webgpu" | "wasm";
export type WebNnDeviceType = "gpu" | "cpu" | "default";

export function isContextLostError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("context is lost") || (lower.includes("mlgraphbuilder") && lower.includes("invalidstateerror"));
}

export function isContextLostRuntimeError(error: unknown): boolean {
  return isContextLostError(toErrorMessage(error));
}

export function isCreateTimeoutError(message: string): boolean {
  return message.includes("Session 创建超时");
}