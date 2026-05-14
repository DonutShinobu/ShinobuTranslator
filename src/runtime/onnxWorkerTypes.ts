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
};

// ---------------------------------------------------------------------------
// OCR single-region fallback decode
// ---------------------------------------------------------------------------

export type OcrSingleDecodeOutput = {
  text: string;
  confidence: number;
  tokenIds: number[];
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
  ): Promise<OcrBatchDecodeOutputItem[]>;
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
  ): Promise<OcrSingleDecodeOutput | null>;
  runOcrColorBatch(
    sessionId: string,
    inputNames: OcrInputNameSet,
    items: OcrColorBatchInputItem[],
    seqLen: number,
    encoderLen: number,
    inputHeight: number,
    inputWidth: number
  ): Promise<(OcrColorResult | null)[]>;
  runOcrColorSingle(
    sessionId: string,
    inputNames: OcrInputNameSet,
    imageData: Float32Array,
    imageDims: number[],
    validEncoderLength: number,
    tokenIds: number[],
    seqLen: number,
    encoderLen: number
  ): Promise<OcrColorResult | null>;
  probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport>;
  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}