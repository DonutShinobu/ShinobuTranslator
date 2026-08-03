/**
 * Type declarations for onnxruntime-node — an optional dependency.
 *
 * This shim allows TypeScript to compile the Node bridge code without
 * requiring onnxruntime-node to be installed. At runtime, the module
 * is loaded via dynamic import() and only resolves if the package is
 * actually present in Node environments.
 *
 * onnxruntime-node extends onnxruntime-common by adding CUDA/DirectML
 * execution providers. The InferenceSession class is the same one from
 * onnxruntime-common, so we re-export it to maintain type compatibility
 * with code that expects ort.InferenceSession.
 */

declare module "onnxruntime-node" {
  // Re-export InferenceSession and Tensor from onnxruntime-common.
  // onnxruntime-node's actual package does this; our shim mirrors it.
  export { InferenceSession, Tensor } from "onnxruntime-common";

  export const env: {
    versions: { node?: string; web?: string };
    logLevel: string;
    wasm: {
      wasmPaths: string;
      numThreads: number;
      proxy: boolean;
    };
  };
}