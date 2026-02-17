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
};

export type PipelineConfig = {
  sourceLang: string;
  targetLang: string;
  translator: 'google_web' | 'llm';
  llmProvider: 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'custom';
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTemperature: number;
  typesetDebug: boolean;
};

export type RuntimeStageStatus = {
  model: "detector" | "ocr" | "inpaint";
  enabled: boolean;
  provider?: "webnn" | "webgpu" | "wasm";
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
};

export type PipelineArtifacts = {
  original: HTMLImageElement;
  detectedRegions: TextRegion[];
  detectionCanvas: HTMLCanvasElement;
  ocrCanvas: HTMLCanvasElement;
  segmentationCanvas: HTMLCanvasElement | null;
  cleanedCanvas: HTMLCanvasElement;
  resultCanvas: HTMLCanvasElement;
  debugOriginalCanvas: HTMLCanvasElement | null;
  typesetDebugLog: PipelineTypesetDebugLog | null;
  translationDebug: TranslationDebugInfo | null;
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
