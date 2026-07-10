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

export type SourceTextLineGeometry = {
  text: string;
  direction: TextDirection;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  fontSize?: number;
};

export type LlmProvider = 'deepseek' | 'gemini' | 'glm' | 'kimi' | 'minimax' | 'mimo' | 'openai' | 'custom';

export type LlmAuthMode = 'api_key' | 'openai_oauth' | 'gemini_app';

export type ImageEngine = 'local' | 'gemini_app';

export type GeminiAppAuthMode = 'browser_session' | 'cookies_permission';

export type GeminiAppModel = 'nano_banana_2' | 'nano_banana_pro';

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
  /** Pre-merge source line/column geometries in reading order. */
  sourceLineGeometries?: SourceTextLineGeometry[];
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
  ocrEngine: 'paddleocr_v6_medium';
  /** Internal benchmark override; production OCR picks its batch compaction policy automatically. */
  ocrCompactActiveBatch?: boolean;
  processMode: 'translate' | 'erase' | 'original';
  diagnosticRunId?: string;
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

export type TypesetDebugGlyphCenter = {
  ch: string;
  x: number;
  y: number;
};

export type TypesetDebugVerticalItem = {
  sourceText: string;
  displayText: string;
  kind: "upright-glyph" | "sideways-run" | "tate-chu-yoko";
  orientation: "upright" | "sideways" | "transformed-upright" | "transformed-sideways";
  unicodeOrientation: "U" | "R" | "Tu" | "Tr";
  policy?: "short-digits" | "terminal-punctuation";
  rotationDeg?: 90;
  sourceStart: number;
  sourceEnd: number;
  sourceGlyphCount: number;
  x: number;
  y: number;
  advanceY: number;
  inkWidth?: number;
  inkHeight?: number;
  renderInlineScale?: number;
  renderCrossScale?: number;
  renderOffsetX?: number;
  renderOffsetY?: number;
  boundaryGap?: number;
};

export type TypesetLayoutDiagnostics = {
  sourceGeometryProfileUsed: boolean;
  sourceFontSize?: number;
  sourceAdvance?: number;
  sourcePitch?: number;
  uniformScale?: number;
  advanceScale: number;
  perColumnAdvanceScales?: number[];
  colSpacingScale: number;
  actualBoxScale?: number;
  useDefaultAdvanceBase: boolean;
  layoutContentHeight: number;
  renderContentHeight: number;
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
  layoutDiagnostics?: TypesetLayoutDiagnostics;
  columnBoxes: TypesetDebugColumnBox[];
  columnCanvasQuads: [QuadPoint, QuadPoint, QuadPoint, QuadPoint][];
  columnGlyphCenters: TypesetDebugGlyphCenter[][];
  columnVerticalItems?: TypesetDebugVerticalItem[][];
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

export type PaddleOcrRegionDebug = {
  regionId: string;
  direction: TextDirection;
  box: Rect;
  inputDims: number[];
  resizedWidth: number;
  inputBytes: number;
  preprocessMs: number;
};

export type PaddleOcrInferenceDebug = {
  runIndex: number;
  regionIds: string[];
  inputDims: number[];
  outputDims?: number[];
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
  decodeMs: number;
  timeSteps?: number;
  numClasses?: number;
  accepted: boolean;
  acceptedCount?: number;
  rejectedCount?: number;
  text?: string;
  texts?: string[];
  confidence?: number;
  error?: string;
};

export type PaddleOcrRunDebug = {
  modelName: string;
  provider?: RuntimeStageStatus["provider"];
  webnnDeviceType?: RuntimeStageStatus["webnnDeviceType"];
  batchMode: 'serial' | 'width-bucket';
  batchBucketWidth?: number;
  coldFirstSerial?: boolean;
  fixedInputWidth?: number;
  sessionOptionsKey?: string;
  inputHeight: number;
  maxInputWidth: number;
  normalize: 'zero_to_one' | 'minus_one_to_one';
  channelOrder: 'rgb' | 'bgr';
  modelLoadMs: number;
  sessionLoadMs: number;
  charsetLoadMs: number;
  preprocessTotalMs: number;
  inferenceTotalMs: number;
  decodeTotalMs: number;
  inputBytesTotal: number;
  outputBytesTotal: number;
  acceptedCount: number;
  rejectedCount: number;
  missingOutputCount: number;
  regions: PaddleOcrRegionDebug[];
  inferenceRuns: PaddleOcrInferenceDebug[];
  colorFillMs?: number;
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
  paddle?: PaddleOcrRunDebug;
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
