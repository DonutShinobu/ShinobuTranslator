import type { ScreenshotRect } from '../screenshot';
import type { ReadingModeAdapter } from '../types';

export type ReaderEngineDetection = {
  confidence: 'strong';
  root: HTMLElement;
  /** Adapter-owned node whose replacement requires rebinding the reader session. */
  sessionAnchor?: Element;
  /** Adapter-owned identity whose change requires rebinding even when DOM nodes are reused. */
  contextKey?: string;
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

/** A structurally detected reader session that can drive the shared reading-mode UI. */
export interface ReaderEngineReadingModeSession
  extends ReaderEngineSession, ReadingModeAdapter {}

export interface ReaderEngineAdapter {
  readonly engineId: string;
  detect(): ReaderEngineDetection | null;
  createReadingModeSession(
    detection: ReaderEngineDetection,
  ): ReaderEngineReadingModeSession;
}
