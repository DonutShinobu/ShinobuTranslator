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

export type TypesetDebugDownloadData = {
  exportedAt: string;
  sourceImageUrl: string;
  stageTimings: StageTiming[];
  runtimeStages: RuntimeStageStatus[];
  translationDebug: TranslationDebugInfo | null;
  ocrDebug: OcrRunDebugInfo | null;
  ocrRegions: OcrRegionLogItem[];
  modelRegions: ModelRegionLogItem[];
  typeset: PipelineTypesetDebugLog;
};

export type { PipelineArtifacts, PipelineProgress, RuntimeStageStatus, StageTiming, TextRegion, TranslationDebugInfo };
