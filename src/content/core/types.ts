import type {
  OcrRunDebugInfo,
  PipelineArtifacts,
  PipelineProgress,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
  TranslationDebugInfo,
} from '../../types';

export interface ImageTarget {
  element: HTMLImageElement;
  key: string;
  originalUrl: string;
}

/** URL-only target for pages that lack a DOM img (virtual-rendered in Pixiv reading mode). */
export interface UrlTarget {
  key: string;
  originalUrl: string;
  pageIndex: number; // 0-indexed page number
}

export interface ReadingModeBarUi {
  host: HTMLElement;
  translateCurrentBtn: HTMLButtonElement;
  translateAllBtn: HTMLButtonElement;
}

export interface SiteAdapter {
  match(): boolean;
  findImages(): ImageTarget[];
  createUiAnchor(target: ImageTarget): HTMLElement;
  applyImage(target: ImageTarget, url: string): void;
  observe(onChange: () => void): () => void;
  /** Whether the site is currently in a multi-page reading mode (e.g. Pixiv manga viewer). */
  isReadingMode?(): boolean;
  /** Discover all page URLs in reading mode. Returns empty array if not in reading mode. */
  findAllPageUrls?(): UrlTarget[];
  /** Get currently visible page targets in reading mode spread. */
  getVisiblePages?(): ImageTarget[];
  /** Total page count in reading mode. Returns 0 if not applicable. */
  getTotalPageCount?(): number;
  /** Create or return the bottom bar button anchor in reading mode. */
  createBottomBarAnchor?(): HTMLElement | null;
  /** Apply translated image to a page by key (works for both DOM img and virtual-rendered pages). */
  applyImageByKey?(key: string, url: string): void;
}

export type PhotoViewStatus = 'idle' | 'running' | 'translated' | 'showingOriginal' | 'error';
export type PhotoDisplayMode = 'translated' | 'original';

export type PhotoState = {
  status: PhotoViewStatus;
  mode: PhotoDisplayMode;
  originalUrl: string;
  translatedUrl?: string;
  debugOriginalUrl?: string;
  debugLogData?: TypesetDebugDownloadData;
  showTypesetDebug: boolean;
  showEraseDebug: boolean;
  stageText: string;
  elapsedText: string;
  errorText: string;
};

export type OcrRegionLogItem = {
  regionId: string;
  direction: TextRegion['direction'];
  box: TextRegion['box'];
  quad?: TextRegion['quad'];
  sourceText: string;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
};

export type ModelRegionLogItem = {
  regionId: string;
  translatedTextRaw: string;
  translatedColumnsRaw: string[];
};

export type ProgressJankEntry = 'image' | 'screenshot' | 'context-image' | 'reading-mode';

export type ProgressJankFrameStats = {
  samples: number;
  maxDeltaMs: number;
  p95DeltaMs: number;
  over33Count: number;
  over50Count: number;
  over100Count: number;
  longestSlowStreak: number;
};

export type ProgressJankUiStats = {
  renderCalls: number;
  renderTotalMs: number;
  renderMaxMs: number;
  stageTextChanges: number;
};

export type ProgressJankStageSummary = {
  stage: string;
  detail: string;
  startMs: number;
  durationMs: number;
  maxFrameDeltaMs: number;
  longFrameCount: number;
  longTaskCount: number;
  mainThreadTaskCount: number;
  maxMainThreadTaskMs: number;
  workerCallCount: number;
  maxWorkerCallMs: number;
};

export type ProgressJankWorkerCall = {
  kind: string;
  model?: string;
  provider?: string;
  inputBytes?: number;
  outputBytes?: number;
  startMs: number;
  durationMs: number;
  stage?: string;
};

export type ProgressJankMainThreadTask = {
  kind: string;
  startMs: number;
  durationMs: number;
  stage?: string;
};

export type ProgressJankWorkerHeartbeatMode = 'worker-raf' | 'worker-timer' | 'unavailable' | 'error';

export type ProgressJankWorkerHeartbeatStats = ProgressJankFrameStats & {
  available: boolean;
  mode: ProgressJankWorkerHeartbeatMode;
  error?: string;
};

export type ProgressJankObserverSupport = {
  longAnimationFrame: boolean;
  longTask: boolean;
  workerHeartbeat: boolean;
  workerHeartbeatMode: ProgressJankWorkerHeartbeatMode;
  workerHeartbeatError?: string;
};

export type ProgressJankLongFrameScript = {
  durationMs: number;
  executionStartMs?: number;
  forcedStyleAndLayoutDurationMs?: number;
  pauseDurationMs?: number;
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  windowAttribution?: string;
};

export type ProgressJankLongFrame = {
  startMs: number;
  durationMs: number;
  blockingDurationMs?: number;
  renderStartMs?: number;
  styleAndLayoutStartMs?: number;
  firstUIEventTimestampMs?: number;
  stage?: string;
  scripts?: ProgressJankLongFrameScript[];
};

export type ProgressJankLongTask = {
  startMs: number;
  durationMs: number;
  stage?: string;
};

export type ProgressJankReport = {
  runId: string;
  entry: ProgressJankEntry;
  totalMs: number;
  observerSupport: ProgressJankObserverSupport;
  frame: ProgressJankFrameStats;
  workerHeartbeat: ProgressJankWorkerHeartbeatStats;
  ui: ProgressJankUiStats;
  stages: ProgressJankStageSummary[];
  workerCalls: ProgressJankWorkerCall[];
  mainThreadTasks: ProgressJankMainThreadTask[];
  longFrames: ProgressJankLongFrame[];
  longTasks: ProgressJankLongTask[];
};

export type TypesetDebugDownloadData = {
  exportedAt: string;
  pageUrl: string;
  sourceImageUrl: string;
  stageTimings: StageTiming[];
  runtimeStages: RuntimeStageStatus[];
  translationDebug: TranslationDebugInfo | null;
  ocrDebug: OcrRunDebugInfo | null;
  progressJank: ProgressJankReport | null;
  ocrRegions: OcrRegionLogItem[];
  modelRegions: ModelRegionLogItem[];
  typeset: PipelineTypesetDebugLog;
};

export type { PipelineArtifacts, PipelineProgress, RuntimeStageStatus, StageTiming, TextRegion, TranslationDebugInfo };
