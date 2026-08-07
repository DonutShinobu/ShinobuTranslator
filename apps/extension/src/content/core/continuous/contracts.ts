import type { ScreenshotRect } from '../screenshot';

export type ReaderEngineDetection = {
  confidence: 'strong';
  root: HTMLElement;
  /** Adapter-owned node whose replacement requires rebinding the reader session. */
  sessionAnchor?: Element;
  evidence: readonly string[];
};

export type ReaderPageIdentity = {
  engineId: string;
  contextKey: string;
  pageIndex: number;
};

export type ReaderPageSource =
  | { kind: 'canvas'; element: HTMLCanvasElement }
  | { kind: 'image'; element: HTMLImageElement }
  | { kind: 'viewport-region' };

export type ReaderPageSurface = {
  identity: ReaderPageIdentity;
  slot: HTMLElement;
  source: ReaderPageSource;
  viewportRect: ScreenshotRect;
  projectionAnchor: HTMLElement;
};

export type ReaderVisibleSpread = {
  pages: readonly ReaderPageSurface[];
};

export type ReaderSessionSignal =
  | { kind: 'structure-changed' }
  | { kind: 'navigation-state-changed' }
  | { kind: 'geometry-changed' }
  | { kind: 'render-settled' };

export interface ReaderEngineSession {
  readonly engineId: string;
  readonly contextKey: string;
  readVisibleSpread(): ReaderVisibleSpread;
  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void;
  dispose(): void;
}

export interface ReaderEngineAdapter {
  readonly engineId: string;
  detect(): ReaderEngineDetection | null;
  createSession(detection: ReaderEngineDetection): ReaderEngineSession;
}

export interface ContinuousTranslationModule {
  start(): void;
  dispose(): void;
}
