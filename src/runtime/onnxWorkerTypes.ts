import type { RuntimeProvider, WebNnDeviceType } from "./onnxTypes";
import type { OnnxSessionOptions } from "./onnxSessionOptions";
import type { RuntimeSelfCheckReport } from "./selfCheck";

// ---------------------------------------------------------------------------
// Tensor transport — plain-data representation of ort.Tensor for comlink boundary.
// Float32Array and BigInt64Array are Transferable via ArrayBuffer transfer.
// ---------------------------------------------------------------------------

export type TensorTransport = {
  data: Float32Array | BigInt64Array | Uint8Array;
  dims: number[];
  type: "float32" | "int64" | "bool";
};

// ---------------------------------------------------------------------------
// Session handle — metadata returned by Worker after session creation.
// The actual ort.InferenceSession lives inside the Worker.
// ---------------------------------------------------------------------------

export type WorkerSessionHandle = {
  sessionId: string;
  provider: RuntimeProvider;
  webnnDeviceType?: WebNnDeviceType;
  inputNames: string[];
  outputNames: string[];
};

// ---------------------------------------------------------------------------
// Inference result — output tensors from a single session.run() call.
// ---------------------------------------------------------------------------

export type InferenceResult = {
  outputs: Record<string, TensorTransport>;
  error?: string;
};

// ---------------------------------------------------------------------------
// GPU detect — result from GPU-preprocessed detection inference
// ---------------------------------------------------------------------------

export type GpuDetectResult = {
  outputs: Record<string, TensorTransport>;
  ratio: number;
  unpaddedWidth: number;
  unpaddedHeight: number;
};

export type PaddleGraphCaptureProbeOptions = {
  modelUrl: string;
  inputWidth?: number;
  batchSize?: number;
  classCount?: number;
  runs?: number;
};

export type PaddleGraphCaptureProbeResult = {
  ok: boolean;
  modelUrl: string;
  inputDims: number[];
  outputDims: number[];
  inputBytes: number;
  outputBytes: number;
  createSessionMs?: number;
  runMs: number[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Worker API — the comlink-exposed interface
// ---------------------------------------------------------------------------

export interface OnnxWorkerApi {
  init(ortPath: string): Promise<void>;
  createSession(
    modelKey: string,
    modelUrl: string,
    preferred: RuntimeProvider[],
    sessionOptions?: OnnxSessionOptions
  ): Promise<WorkerSessionHandle>;
  runInference(
    sessionId: string,
    feeds: Record<string, TensorTransport>
  ): Promise<InferenceResult>;
  probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport>;
  probePaddleGraphCapture(
    options: PaddleGraphCaptureProbeOptions
  ): Promise<PaddleGraphCaptureProbeResult>;
  runDetectWithGpuPreprocess(
    sessionId: string,
    imageSource: ImageBitmap
  ): Promise<GpuDetectResult>;
  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}
