import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
  ReaderEngineSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../core/continuous/contracts';

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
};

class ComiciReaderEngineSession implements ReaderEngineSession {
  readonly engineId = 'comici';
  readonly contextKey: string;
  private readonly observers = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly document: Document,
    location: Pick<Location, 'origin' | 'pathname'>,
  ) {
    const viewerId = root.getAttribute('data-comici-viewer-id') ?? '';
    this.contextKey = `comici:${viewerId}:${location.origin}${location.pathname}`;
  }

  readVisibleSpread(): ReaderVisibleSpread {
    const pages = this.document.querySelector<HTMLElement>(pagesSelector);
    if (!pages || !this.root.isConnected) return { pages: [] };
    const rootRect = this.root.getBoundingClientRect();
    const surfaces = [...pages.querySelectorAll<HTMLElement>(directPageSelector)]
      .map((slot, pageIndex) => {
        if (
          !slot.classList.contains('mode-rendered')
          || excludedPageClasses.some((name) => slot.classList.contains(name))
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

  createSession(detection: ReaderEngineDetection): ReaderEngineSession {
    return new ComiciReaderEngineSession(
      detection.root,
      this.dependencies.document,
      this.dependencies.location,
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
