import type { PhotoStateStore } from '../state/photoStateStore';
import type { ImageTranslationExecutionArbiter } from '../translation/imageTranslationExecutionArbiter';
import type { ReaderEngineReadingModeSession } from '../continuous/contracts';
import type { DetectedReaderEngine } from '../continuous/readerEngineRegistry';
import { ReaderEngineRegistry } from '../continuous/readerEngineRegistry';
import { ReadingModeController } from './readingModeController';

export type ReaderEngineReadingModeModuleDependencies = {
  registry: ReaderEngineRegistry;
  stateStore: PhotoStateStore;
  executionArbiter: ImageTranslationExecutionArbiter;
  document?: Document;
  window?: Window;
};

export interface ReaderEngineReadingModeModulePort {
  start(): void;
  dispose(): void;
}

export class ReaderEngineReadingModeModule implements ReaderEngineReadingModeModulePort {
  private readonly document: Document;
  private readonly window: Window;
  private globalObserver: MutationObserver | null = null;
  private session: ReaderEngineReadingModeSession | null = null;
  private sessionDetection: DetectedReaderEngine | null = null;
  private stopSessionObserver: (() => void) | null = null;
  private controller: ReadingModeController | null = null;
  private syncTimer: number | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly dependencies: ReaderEngineReadingModeModuleDependencies) {
    this.document = dependencies.document ?? globalThis.document;
    this.window = dependencies.window ?? globalThis.window;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (typeof MutationObserver !== 'undefined' && this.document.documentElement) {
      this.globalObserver = new MutationObserver(() => this.scheduleSync());
      this.globalObserver.observe(this.document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['id', 'class', 'data-comici-viewer-id', 'data-value'],
      });
    }
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.globalObserver?.disconnect();
    this.globalObserver = null;
    this.cancelSync();
    this.unbindSession();
  }

  private scheduleSync(): void {
    if (this.disposed || this.syncTimer !== null) return;
    this.syncTimer = this.window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 50);
  }

  private cancelSync(): void {
    if (this.syncTimer === null) return;
    this.window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private sameDetection(next: DetectedReaderEngine): boolean {
    const current = this.sessionDetection;
    return Boolean(
      current
      && current.adapter === next.adapter
      && current.detection.root === next.detection.root
      && current.detection.sessionAnchor === next.detection.sessionAnchor
      && current.detection.contextKey === next.detection.contextKey
      && next.detection.root.isConnected
      && (!next.detection.sessionAnchor || next.detection.sessionAnchor.isConnected),
    );
  }

  private sync(): void {
    if (this.disposed) return;
    const detected = this.dependencies.registry.detect();
    if (!detected?.adapter.createReadingModeSession) {
      this.unbindSession();
      return;
    }
    if (!this.session || !this.sameDetection(detected)) {
      this.unbindSession();
      const session = detected.adapter.createReadingModeSession(detected.detection);
      this.session = session;
      this.sessionDetection = detected;
      this.controller = new ReadingModeController(
        session,
        this.dependencies.stateStore,
        this.dependencies.executionArbiter,
        () => this.scheduleSync(),
        () => this.cancelSync(),
      );
      this.stopSessionObserver = session.observe(() => this.scheduleSync());
    }
    this.controller?.sync();
  }

  private unbindSession(): void {
    this.controller?.teardown();
    this.controller = null;
    this.stopSessionObserver?.();
    this.stopSessionObserver = null;
    this.session?.dispose();
    this.session = null;
    this.sessionDetection = null;
  }
}

export function createReaderEngineReadingModeModule(
  dependencies: ReaderEngineReadingModeModuleDependencies,
): ReaderEngineReadingModeModulePort {
  return new ReaderEngineReadingModeModule(dependencies);
}
