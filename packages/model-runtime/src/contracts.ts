import type { OnnxSessionOptions } from './runtime/onnxSessionOptions';
import type { RuntimeProvider } from './runtime/onnxTypes';
import type {
  GpuDetectResult,
  InferenceResult,
  TensorTransport,
  WorkerSessionHandle,
} from './runtime/onnxWorkerTypes';
import type { ModelName } from './runtime/modelRegistry';

export type ModelDescriptor = {
  name: string;
  task: string;
  url: string;
  input: number[];
  runtime?: RuntimeProvider[];
  dictUrl?: string;
  normalize?: 'zero_to_one' | 'minus_one_to_one';
  channelOrder?: 'rgb' | 'bgr';
  outputNormalize?: 'zero_to_one' | 'minus_one_to_one' | 'zero_to_255';
  maskFill?: 'zero_before_normalize' | 'zero_after_normalize';
  maskInputName?: string;
};

export interface ModelRuntime {
  readModel(name: ModelName): Promise<ModelDescriptor>;
  getSession(
    name: ModelName,
    preferred?: RuntimeProvider[],
    options?: OnnxSessionOptions,
  ): Promise<WorkerSessionHandle>;
  run(
    sessionId: string,
    feeds: Record<string, TensorTransport>,
  ): Promise<InferenceResult>;
  runImage(sessionId: string, image: ImageBitmap): Promise<GpuDetectResult>;
  readTextResource(url: string): Promise<string>;
  releaseSession(name: ModelName): Promise<void>;
  dispose(): Promise<void>;
}

export type ModelRuntimeWorkerCall = {
  kind: string;
  model?: string;
  provider?: string;
  inputBytes?: number;
  outputBytes?: number;
  startedAt: number;
  durationMs: number;
  error?: string;
};

export type ModelRuntimeEvent = {
  kind:
    | 'worker-bootstrap-attempt'
    | 'worker-bootstrap-complete'
    | 'session-create-start'
    | 'session-create-complete'
    | 'session-cache-hit'
    | 'provider-fallback'
    | 'inference-failure';
  model?: string;
  provider?: string;
  message: string;
  data?: Record<string, unknown>;
  error?: unknown;
};

export interface ModelRuntimePerformanceObserver {
  recordWorkerCall(call: ModelRuntimeWorkerCall): void;
  recordRuntimeEvent?(event: ModelRuntimeEvent): void;
}
