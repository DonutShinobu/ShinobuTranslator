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
};

export type PipelineConfig = {
  sourceLang: string;
  targetLang: string;
  translator: 'google_web' | 'llm';
  llmProvider: 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'custom';
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export type RuntimeStageStatus = {
  model: "detector" | "ocr" | "inpaint";
  enabled: boolean;
  provider?: "webnn" | "webgpu" | "wasm";
  webnnDeviceType?: "gpu" | "cpu" | "default";
  detail: string;
};

export type PipelineArtifacts = {
  original: HTMLImageElement;
  detectedRegions: TextRegion[];
  detectionCanvas: HTMLCanvasElement;
  ocrCanvas: HTMLCanvasElement;
  segmentationCanvas: HTMLCanvasElement | null;
  cleanedCanvas: HTMLCanvasElement;
  resultCanvas: HTMLCanvasElement;
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
