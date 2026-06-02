import type { PipelineCanvas, PipelineImage, PipelineImageData } from "./runtime/platform";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type QuadPoint = {
  x: number;
  y: number;
};

export type TextDirection = "h" | "v";

export type LlmProvider = 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'mimo' | 'openai' | 'custom';

export type LlmAuthMode = 'api_key' | 'openai_oauth';

export type TextRegion = {
  id: string;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  prob?: number;
  fontSize?: number;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
  /** Number of original text lines before merge (used for region expansion). */
  originalLineCount?: number;
  sourceText: string;
  translatedText: string;
  /** Optional LLM-provided vertical columns, ordered right-to-left. */
  translatedColumns?: string[];
  bubbleBox?: Rect;
  bubbleMask?: PipelineImageData;
};

export type PipelineConfig = {
  sourceLang: string;
  targetLang: string;
  translator: 'google_web' | 'llm';
  llmProvider: LlmProvider;
  llmAuthMode: LlmAuthMode;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  typesetDebug: boolean;
  eraseDebug: boolean;
  collectDebugLog: boolean;
  ocrEngine: 'builtin' | 'paddleocr';
  /** Internal benchmark override; production OCR picks its batch compaction policy automatically. */
  ocrCompactActiveBatch?: boolean;
  processMode: 'translate' | 'erase' | 'original';
};

export type RuntimeStageStatus = {
  model: "detector" | "ocr" | "inpaint";
  enabled: boolean;
  provider?: "webnn" | "webgpu" | "wasm" | "cuda" | "cpu";
  webnnDeviceType?: "gpu" | "cpu" | "default";
  detail: string;
};

export type TypesetDebugColumnBreakReason = 'start' | 'model' | 'wrap' | 'both';

export type TypesetDebugColumnSegmentSource = 'model' | 'split';

export type TypesetDebugColumnBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TypesetDebugRegionLog = {
  regionId: string;
  regionIndex: number;
  direction: TextDirection;
  sourceText: string;
  translatedTextRaw: string;
  translatedTextUsed: string;
  translatedColumnsRaw: string[];
  preferredColumns: string[];
  sourceColumns: string[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
  initialFontSize: number;
  fittedFontSize: number;
  sourceBox: Rect;
  expandedBox: Rect;
  sourceQuad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  expandedQuad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
  columnBreakReasons: TypesetDebugColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: TypesetDebugColumnSegmentSource[];
  columnBoxes: TypesetDebugColumnBox[];
  columnCanvasQuads: [QuadPoint, QuadPoint, QuadPoint, QuadPoint][];
};

export type PipelineTypesetDebugLog = {
  generatedAt: string;
  regions: TypesetDebugRegionLog[];
};

export type TranslationDebugInfo = {
  llmBatchRawResponse?: string;
  llmBatchParseError?: string;
  llmBatchError?: string;
  llmBatchFailed?: boolean;
  llmBatchRequestedRegionCount?: number;
  llmBatchHitRegionCount?: number;
  llmFallbackUsed?: boolean;
  llmFallbackRegionCount?: number;
  llmFallbackRequestCount?: number;
};

export type OcrRunDebugStep = {
  step: number;
  activeCount: number;
  batchSize?: number;
  compactFallback?: boolean;
  durationMs: number;
  postprocessMode?: 'cpu' | 'gpu' | 'gpu-fallback';
  postprocessMs?: number;
};

export type OcrRunDebugRegionFallback = {
  regionId: string;
  durationMs: number;
  accepted: boolean;
  confidence?: number;
  error?: string;
};

export type OcrRunDebugChunk = {
  chunkIndex: number;
  chunkSize: number;
  regionIds: string[];
  decodeMode: 'batch' | 'fallback';
  encoderCache?: boolean;
  compactActiveBatch?: boolean;
  encoderRunMs?: number;
  decoderRunMs?: number;
  decodeAccepted: number;
  decodeConfidenceAvg?: number;
  decodeSessionRunCount: number;
  decodeSessionRunTotalMs: number;
  decodeSteps: OcrRunDebugStep[];
  fallbackRegions: OcrRunDebugRegionFallback[];
};

export type OcrRunDebugInfo = {
  mode: 'autoregressive' | 'ctc';
  candidateCount: number;
  preparedCount: number;
  preprocessTotalMs: number;
  preprocessPerRegionMs: Array<{ regionId: string; durationMs: number }>;
  chunkBatchSize: number;
  chunks: OcrRunDebugChunk[];
  colorDecodeMode: 'none' | 'batch' | 'fallback' | 'reuse';
  colorBatchSize: number;
  colorSessionRunCount: number;
  colorSessionRunTotalMs: number;
  colorTotalMs: number;
  colorFallbackRegions: OcrRunDebugRegionFallback[];
  fallbackTriggerCount: number;
  totalSessionRunCount: number;
  totalSessionRunMs: number;
};

export type MaskDebugLayers = {
  refinedMask: Uint8Array;
  perRegionDilated: Uint8Array;
  globalDilated: Uint8Array;
  scaledWidth: number;
  scaledHeight: number;
};

export type RefineTextMaskResult = {
  refinedMaskCanvas: PipelineCanvas;
  debugLayers?: MaskDebugLayers;
};

export type PipelineArtifacts = {
  original: PipelineImage;
  detectedRegions: TextRegion[];
  detectionCanvas: PipelineCanvas;
  ocrCanvas: PipelineCanvas;
  segmentationCanvas: PipelineCanvas | null;
  cleanedCanvas: PipelineCanvas;
  resultCanvas: PipelineCanvas;
  debugOriginalCanvas: PipelineCanvas | null;
  typesetDebugLog: PipelineTypesetDebugLog | null;
  translationDebug: TranslationDebugInfo | null;
  ocrDebug: OcrRunDebugInfo | null;
  runtimeStages: RuntimeStageStatus[];
  stageTimings: StageTiming[];
};

export type StageTiming = {
  stage: string;
  label: string;
  durationMs: number;
};

export type PipelineProgress = {
  stage: string;
  detail: string;
};
