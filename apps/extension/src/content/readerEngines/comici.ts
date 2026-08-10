import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
  ReaderEngineReadingModeSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../core/reading/readerEngineContracts';
import type { ReadingPageReference } from '../core/types';
import {
  createRuntimeImageDownloader,
  type DownloadImageForTranslation,
} from '../core/translation/imageTranslationExecution';
import { sendRuntimeMessage } from '../../shared/messages';
import {
  acquireComiciPageFile,
  createComiciManifestClient,
  restoreComiciPageImage,
  type ComiciManifestClient,
} from './comiciManifest';

const rootSelector = '#comici-viewer[data-comici-viewer-id].-cv';
const pagesSelector = '#xCVPages.-cv-pages';
const directPageSelector = ':scope > .-cv-page';
const excludedPageClasses = ['mode-empty', 'mode-pr', 'mode-good', 'mode-last'] as const;

function intersectionArea(left: DOMRect, right: DOMRect): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function isVisibleBodyCanvas(canvasRect: DOMRect, rootRect: DOMRect): boolean {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return false;
  const centerX = canvasRect.left + canvasRect.width / 2;
  const centerY = canvasRect.top + canvasRect.height / 2;
  const centerInside = centerX >= rootRect.left
    && centerX <= rootRect.right
    && centerY >= rootRect.top
    && centerY <= rootRect.bottom;
  return centerInside
    && intersectionArea(canvasRect, rootRect) >= canvasRect.width * canvasRect.height * 0.5;
}

function isExtensionNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const names = typeof element.getAttributeNames === 'function'
    ? element.getAttributeNames()
    : ['data-mt-projection', 'data-mt-continuous-projection', 'data-mt-continuous-ui']
        .filter((name) => element.getAttribute?.(name) !== null);
  return names.some((name) => name.startsWith('data-mt-'));
}

function mutationOnlyTouchesExtensionNodes(record: MutationRecord): boolean {
  if (isExtensionNode(record.target)) return true;
  if (record.type !== 'childList') return false;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.length > 0 && changed.every(isExtensionNode);
}

export type ComiciReaderEngineDependencies = {
  document: Document;
  location: Pick<Location, 'origin' | 'pathname'>;
  fetch?: typeof fetch;
  downloadImage?: DownloadImageForTranslation;
  restoreImage?: typeof restoreComiciPageImage;
  now?: () => number;
};

class ComiciReaderEngineSession implements ReaderEngineReadingModeSession {
  readonly engineId = 'comici';
  readonly contextKey: string;
  private readonly observers = new Set<() => void>();
  private readonly manifestClient: ComiciManifestClient;
  private readonly downloadImage: DownloadImageForTranslation;
  private readonly restoreImage: typeof restoreComiciPageImage;
  private readonly now: () => number;
  private bottomBarAnchor: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly document: Document,
    location: Pick<Location, 'origin' | 'pathname'>,
    dependencies: Pick<
      ComiciReaderEngineDependencies,
      'fetch' | 'downloadImage' | 'restoreImage' | 'now'
    >,
  ) {
    const viewerId = root.getAttribute('data-comici-viewer-id') ?? '';
    this.contextKey = `comici:${viewerId}:${location.origin}${location.pathname}`;
    this.manifestClient = createComiciManifestClient({
      root,
      location,
      fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    });
    this.downloadImage = dependencies.downloadImage
      ?? createRuntimeImageDownloader(sendRuntimeMessage);
    this.restoreImage = dependencies.restoreImage ?? restoreComiciPageImage;
    this.now = dependencies.now ?? Date.now;
  }

  getReadingContextKey(): string {
    return this.contextKey;
  }

  private pageKey(pageIndex: number): string {
    return `${this.contextKey}:page:${pageIndex}`;
  }

  private pageReference(pageIndex: number): string {
    return `engine-source:${this.pageKey(pageIndex)}`;
  }

  private readBodySlots(): Array<{ slot: HTMLElement; pageIndex: number }> {
    const pages = this.document.querySelector<HTMLElement>(pagesSelector);
    if (!pages) return [];
    return [...pages.querySelectorAll<HTMLElement>(directPageSelector)]
      .filter((slot) => !excludedPageClasses.some((name) => slot.classList.contains(name)))
      .map((slot, pageIndex) => ({ slot, pageIndex }));
  }

  readVisibleSpread(): ReaderVisibleSpread {
    const pages = this.document.querySelector<HTMLElement>(pagesSelector);
    if (!pages || !this.root.isConnected) return { pages: [] };
    const rootRect = this.root.getBoundingClientRect();
    const surfaces = this.readBodySlots()
      .map(({ slot, pageIndex }) => {
        if (
          !slot.classList.contains('mode-rendered')
        ) {
          return null;
        }
        const canvas = slot.querySelector<HTMLCanvasElement>('.-cv-page-canvas > canvas');
        const projectionAnchor = slot.querySelector<HTMLElement>('.-cv-page-content');
        if (!canvas?.isConnected || !projectionAnchor) return null;
        const canvasRect = canvas.getBoundingClientRect();
        if (!isVisibleBodyCanvas(canvasRect, rootRect)) return null;
        return {
          identity: {
            engineId: this.engineId,
            contextKey: this.contextKey,
            pageIndex,
          },
          slot,
          source: { kind: 'canvas' as const, element: canvas },
          viewportRect: {
            left: canvasRect.left,
            top: canvasRect.top,
            width: canvasRect.width,
            height: canvasRect.height,
          },
          projectionAnchor,
        };
      })
      .filter((surface): surface is NonNullable<typeof surface> => surface !== null);
    return { pages: surfaces };
  }

  getVisiblePages(): readonly ReadingPageReference[] {
    return this.readVisibleSpread().pages.map(({ identity }) => ({
      key: this.pageKey(identity.pageIndex),
      originalUrl: this.pageReference(identity.pageIndex),
      pageIndex: identity.pageIndex,
    }));
  }

  async discoverReadingPages(signal?: AbortSignal) {
    const controller = signal ? null : new AbortController();
    try {
      const manifest = await this.manifestClient.loadComplete(signal ?? controller!.signal);
      return {
        status: 'complete' as const,
        pages: manifest.pages.map(({ pageIndex }) => ({
          key: this.pageKey(pageIndex),
          originalUrl: this.pageReference(pageIndex),
          pageIndex,
        })),
      };
    } catch {
      return { status: 'incomplete' as const, reason: 'request-failed' as const };
    }
  }

  async prepareReadingPage(page: ReadingPageReference, signal: AbortSignal) {
    if (!Number.isInteger(page.pageIndex) || Number(page.pageIndex) < 0) {
      throw new Error('Comici reading page has no logical page index');
    }
    const file = await acquireComiciPageFile(
      Number(page.pageIndex),
      this.manifestClient,
      this.downloadImage,
      this.restoreImage,
      signal,
      this.now,
    );
    return { source: { kind: 'prepared-file' as const, file } };
  }

  createBottomBarAnchor(): HTMLElement | null {
    if (!this.root.isConnected) return null;
    const fullscreen = this.document.fullscreenElement;
    const parent = fullscreen && fullscreen.contains(this.root)
      ? fullscreen
      : this.document.body ?? this.root;
    if (this.bottomBarAnchor?.isConnected && this.bottomBarAnchor.parentElement === parent) {
      return this.bottomBarAnchor;
    }
    this.bottomBarAnchor?.remove();
    const anchor = this.document.createElement('div');
    anchor.dataset.mtReaderEngineUi = 'comici';
    anchor.style.position = 'fixed';
    anchor.style.right = '16px';
    anchor.style.bottom = '16px';
    anchor.style.zIndex = '2147483646';
    anchor.style.pointerEvents = 'auto';
    parent.appendChild(anchor);
    this.bottomBarAnchor = anchor;
    return anchor;
  }

  applyImageByKey(key: string, url: string): void {
    const target = this.readBodySlots().find(({ pageIndex }) => this.pageKey(pageIndex) === key);
    if (!target) return;
    const projections = [...target.slot.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]')];
    if (url === this.pageReference(target.pageIndex)) {
      for (const projection of projections) projection.remove();
      return;
    }
    const canvas = target.slot.querySelector<HTMLCanvasElement>('.-cv-page-canvas > canvas');
    const projectionAnchor = target.slot.querySelector<HTMLElement>('.-cv-page-content');
    if (!canvas?.isConnected || !projectionAnchor) return;
    const image = projections[0] ?? this.document.createElement('img');
    for (const duplicate of projections.slice(1)) duplicate.remove();
    image.dataset.mtReadingProjection = '';
    image.alt = '';
    image.src = url;
    image.style.position = 'absolute';
    image.style.pointerEvents = 'none';
    image.style.zIndex = '2';
    image.style.objectFit = 'fill';
    if (image.parentElement !== projectionAnchor) projectionAnchor.appendChild(image);
    const anchorRect = projectionAnchor.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    image.style.left = `${canvasRect.left - anchorRect.left}px`;
    image.style.top = `${canvasRect.top - anchorRect.top}px`;
    image.style.width = `${canvasRect.width}px`;
    image.style.height = `${canvasRect.height}px`;
  }

  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void {
    if (this.disposed) return () => undefined;
    const pages = this.document.querySelector<HTMLElement>(pagesSelector);
    if (!pages) return () => undefined;

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => onSignal({ kind: 'geometry-changed' }));
    const resizeTargets = new Set<Element>();
    const syncResizeTargets = (): void => {
      const current = new Set<Element>([this.root]);
      for (const surface of this.readVisibleSpread().pages) {
        current.add(surface.slot);
        if (surface.source.kind !== 'viewport-region') current.add(surface.source.element);
      }
      for (const target of resizeTargets) {
        if (current.has(target)) continue;
        resizeObserver?.unobserve(target);
        resizeTargets.delete(target);
      }
      for (const target of current) {
        if (resizeTargets.has(target)) continue;
        resizeObserver?.observe(target);
        resizeTargets.add(target);
      }
    };
    syncResizeTargets();

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          const relevant = records.filter((record) => !mutationOnlyTouchesExtensionNodes(record));
          if (relevant.length === 0) return;
          syncResizeTargets();
          const navigationChanged = relevant.some((record) => {
            const target = record.target as Element;
            return typeof target.matches === 'function'
              && target.matches('.-cv-f-page-current');
          });
          onSignal({ kind: navigationChanged ? 'navigation-state-changed' : 'structure-changed' });
        });
    mutationObserver?.observe(pages, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'width', 'height'],
    });
    mutationObserver?.observe(this.root, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    const onTransitionEnd = (): void => onSignal({ kind: 'render-settled' });
    const onFullscreenChange = (): void => onSignal({ kind: 'geometry-changed' });
    const onVisibilityChange = (): void => onSignal({ kind: 'navigation-state-changed' });
    pages.addEventListener('transitionend', onTransitionEnd);
    this.document.addEventListener('fullscreenchange', onFullscreenChange);
    this.document.addEventListener('visibilitychange', onVisibilityChange);

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      pages.removeEventListener('transitionend', onTransitionEnd);
      this.document.removeEventListener('fullscreenchange', onFullscreenChange);
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.observers.delete(stop);
    };
    this.observers.add(stop);
    return stop;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of [...this.observers]) stop();
    this.bottomBarAnchor?.remove();
    this.bottomBarAnchor = null;
    for (const projection of this.root.querySelectorAll('[data-mt-reading-projection]')) {
      projection.remove();
    }
  }
}

class ComiciReaderEngineAdapter implements ReaderEngineAdapter {
  readonly engineId = 'comici';

  constructor(private readonly dependencies: ComiciReaderEngineDependencies) {}

  detect(): ReaderEngineDetection | null {
    const root = this.dependencies.document.querySelector<HTMLElement>(rootSelector);
    const pages = this.dependencies.document.querySelector<HTMLElement>(pagesSelector);
    if (!root || !pages || !pages.querySelector(directPageSelector)) return null;
    return {
      confidence: 'strong',
      root,
      sessionAnchor: pages,
      evidence: [
        rootSelector,
        pagesSelector,
        '#xCVPages > .-cv-page',
      ],
    };
  }

  createReadingModeSession(detection: ReaderEngineDetection): ReaderEngineReadingModeSession {
    return new ComiciReaderEngineSession(
      detection.root,
      this.dependencies.document,
      this.dependencies.location,
      this.dependencies,
    );
  }
}

export function createComiciReaderEngineAdapter(
  dependencies: ComiciReaderEngineDependencies = {
    document: globalThis.document,
    location: globalThis.location,
  },
): ReaderEngineAdapter {
  return new ComiciReaderEngineAdapter(dependencies);
}
