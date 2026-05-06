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

export interface SiteAdapter {
  match(): boolean;
  findImages(): ImageTarget[];
  createUiAnchor(target: ImageTarget): HTMLElement;
  applyImage(target: ImageTarget, url: string): void;
  observe(onChange: () => void): () => void;
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

export type { PipelineArtifacts, PipelineProgress, RuntimeStageStatus, StageTiming, TextRegion };
