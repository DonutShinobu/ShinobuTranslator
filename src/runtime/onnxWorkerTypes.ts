import type { RuntimeProvider, WebNnDeviceType } from "./onnxTypes";
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
// OCR input name set — identifies which input slots the AR decoder uses.
// ---------------------------------------------------------------------------

export type OcrInputNameSet = {
  imageInput: string;
  charIdxInput: string;
  decoderMaskInput: string;
  encoderMaskInput: string;
};

// ---------------------------------------------------------------------------
// OCR batch decode — input/output items for the batch AR decode loop.
// ---------------------------------------------------------------------------

export type OcrBatchDecodeInputItem = {
  regionId: string;
  imageData: Float32Array;
  imageDims: number[];
  validEncoderLength: number;
};

export type OcrBatchDecodeOutputItem = {
  regionId: string;
  text: string;
  confidence: number;
  tokenIds: number[];
  imageData: Float32Array;
  imageDims: number[];
  validEncoderLength: number;
  colors?: OcrColorResult;
};

export type OcrDecodeTelemetryStep = {
  step: number;
  activeCount: number;
  batchSize?: number;
  compactFallback?: boolean;
  durationMs: number;
  postprocessMode?: 'cpu' | 'gpu' | 'gpu-fallback';
  postprocessMs?: number;
};

export type OcrDecodeTelemetry = {
  sessionRunCount: number;
  sessionRunTotalMs: number;
  encoderRunMs?: number;
  decoderRunMs?: number;
  steps: OcrDecodeTelemetryStep[];
};

export type OcrSplitInputNameSet = {
  encoderImageInput: string;
  encoderMaskInput: string;
  memoryOutput: string;
  decoderMemoryInput: string;
  decoderCharIdxInput: string;
  decoderMaskInput: string;
  decoderEncoderMaskInput: string;
};

export type OcrBatchDecodeResult = {
  items: OcrBatchDecodeOutputItem[];
  telemetry: OcrDecodeTelemetry;
};

// ---------------------------------------------------------------------------
// OCR single-region fallback decode
// ---------------------------------------------------------------------------

export type OcrSingleDecodeOutput = {
  text: string;
  confidence: number;
  tokenIds: number[];
};

export type OcrSingleDecodeResult = {
  output: OcrSingleDecodeOutput | null;
  telemetry: OcrDecodeTelemetry;
};

// ---------------------------------------------------------------------------
// OCR color decode — batch and single
// ---------------------------------------------------------------------------

export type OcrColorBatchInputItem = {
  imageData: Float32Array;
  imageDims: number[];
  validEncoderLength: number;
  tokenIds: number[];
};

export type OcrColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

export type OcrColorDecodeTelemetry = {
  sessionRunCount: number;
  sessionRunTotalMs: number;
};

export type OcrColorBatchResult = {
  colors: (OcrColorResult | null)[];
  telemetry: OcrColorDecodeTelemetry;
};

export type OcrColorSingleResult = {
  color: OcrColorResult | null;
  telemetry: OcrColorDecodeTelemetry;
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

// ---------------------------------------------------------------------------
// Worker API — the comlink-exposed interface
// ---------------------------------------------------------------------------

export interface OnnxWorkerApi {
  init(ortPath: string): Promise<void>;
  createSession(
    modelKey: string,
    modelUrl: string,
    preferred: RuntimeProvider[]
  ): Promise<WorkerSessionHandle>;
  runInference(
    sessionId: string,
    feeds: Record<string, TensorTransport>
  ): Promise<InferenceResult>;
  runOcrBatchDecode(
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
  ): Promise<OcrBatchDecodeResult>;
  runOcrSplitBatchDecode(
    encoderSessionId: string,
    decoderSessionId: string,
    inputNames: OcrSplitInputNameSet,
    items: OcrBatchDecodeInputItem[],
    options: {
      seqLen: number;
      encoderLen: number;
      maxSteps: number;
      charset: string[] | null;
      inputHeight: number;
      inputWidth: number;
    }
  ): Promise<OcrBatchDecodeResult>;
  runOcrSingleDecode(
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
  ): Promise<OcrSingleDecodeResult>;
  runOcrColorBatch(
    sessionId: string,
    inputNames: OcrInputNameSet,
    items: OcrColorBatchInputItem[],
    seqLen: number,
    encoderLen: number,
    inputHeight: number,
    inputWidth: number
  ): Promise<OcrColorBatchResult>;
  runOcrColorSingle(
    sessionId: string,
    inputNames: OcrInputNameSet,
    imageData: Float32Array,
    imageDims: number[],
    validEncoderLength: number,
    tokenIds: number[],
    seqLen: number,
    encoderLen: number
  ): Promise<OcrColorSingleResult>;
  probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport>;
  runDetectWithGpuPreprocess(
    sessionId: string,
    imageSource: ImageBitmap
  ): Promise<GpuDetectResult>;
  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}
