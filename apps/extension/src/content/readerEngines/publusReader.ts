import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
  ReaderEngineReadingModeSession,
  ReaderEngineSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../core/continuous/contracts';
import type { ReadingPageReference } from '../core/types';

const rootSelector = '#viewer.viewer, #viewer';
const rendererSelector = '#renderer';
const counterSelector = '#pageSliderCounter';
const canvasSelector = '#viewport0 canvas, #viewport1 canvas, #viewportW canvas';

type PublusLocation = Pick<Location, 'href'>;

export type PublusReaderDependencies = {
  document: Document;
  window: Window;
  location: PublusLocation;
};

type PublusDetectionConfig = {
  contextKey: string;
  renderer: HTMLElement;
};

function hashIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function createContextKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    for (const volatileKey of ['time', 'dmytime', '_']) url.searchParams.delete(volatileKey);
    url.hash = '';
    url.searchParams.sort();
    return `publus-reader:${url.origin}${url.pathname}:${hashIdentity(url.href)}`;
  } catch {
    return null;
  }
}

function hasPublusImageReaderScript(document: Document): boolean {
  return [...document.scripts]
    .map((script) => script.src)
    .filter(Boolean)
    .some((source) => /\/viewer_image_[^/]*\.js(?:\?|$)/iu.test(source));
}

function readDetectionConfig(
  root: HTMLElement,
  dependencies: PublusReaderDependencies,
): PublusDetectionConfig | null {
  const renderer = root.querySelector<HTMLElement>(rendererSelector);
  const contextKey = createContextKey(dependencies.location.href);
  return renderer && contextKey ? { contextKey, renderer } : null;
}

function parseCurrentPageIndex(document: Document): number | null {
  const text = document.querySelector(counterSelector)?.textContent ?? '';
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/u.exec(text);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (
    !Number.isSafeInteger(current)
    || !Number.isSafeInteger(total)
    || current < 1
    || total < current
  ) {
    return null;
  }
  return current - 1;
}

function intersectionArea(rect: DOMRect, viewportWidth: number, viewportHeight: number): number {
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

function isExtensionNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return Boolean(element.closest?.('[data-mt-reading-projection], [data-mt-reader-engine-ui]'));
}

function mutationOnlyTouchesExtensionNodes(record: MutationRecord): boolean {
  const changed = [...record.addedNodes, ...record.removedNodes];
  if (record.type === 'attributes') changed.push(record.target);
  return changed.length > 0 && changed.every(isExtensionNode);
}

class PublusReaderSession implements ReaderEngineReadingModeSession {
  readonly engineId = 'publus-reader';
  readonly contextKey: string;
  private readonly observerStops = new Set<() => void>();
  private bottomBarAnchor: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: HTMLElement,
    private readonly document: Document,
    private readonly window: Window,
    config: PublusDetectionConfig,
  ) {
    this.contextKey = config.contextKey;
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

  private readActiveSurface(): {
    canvas: HTMLCanvasElement;
    viewport: HTMLElement;
  } | null {
    const candidates = [...this.renderer.querySelectorAll<HTMLCanvasElement>(canvasSelector)]
      .map((canvas) => {
        const viewport = canvas.closest<HTMLElement>('#viewport0, #viewport1, #viewportW');
        if (!viewport) return null;
        const rect = canvas.getBoundingClientRect();
        const viewportStyle = this.window.getComputedStyle?.(viewport);
        const canvasStyle = this.window.getComputedStyle?.(canvas);
        const visible = canvas.isConnected
          && viewport.isConnected
          && rect.width > 0
          && rect.height > 0
          && viewportStyle?.display !== 'none'
          && viewportStyle?.visibility !== 'hidden'
          && canvasStyle?.display !== 'none'
          && canvasStyle?.visibility !== 'hidden'
          && Number(viewportStyle?.opacity ?? '1') > 0
          && Number(canvasStyle?.opacity ?? '1') > 0;
        return {
          canvas,
          viewport,
          visible,
          area: intersectionArea(rect, this.window.innerWidth, this.window.innerHeight),
          zIndex: Number(viewportStyle?.zIndex ?? viewport.style.zIndex ?? 0) || 0,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => (
        candidate !== null && candidate.visible && candidate.area > 0
      ))
      .sort((left, right) => right.zIndex - left.zIndex || right.area - left.area);
    const active = candidates[0];
    return active ? { canvas: active.canvas, viewport: active.viewport } : null;
  }

  readVisibleSpread(): ReaderVisibleSpread {
    const pageIndex = parseCurrentPageIndex(this.document);
    const active = this.readActiveSurface();
    if (pageIndex === null || !active) return { pages: [] };
    const rect = active.canvas.getBoundingClientRect();
    return {
      pages: [{
        identity: { engineId: this.engineId, contextKey: this.contextKey, pageIndex },
        slot: active.viewport,
        source: { kind: 'canvas', element: active.canvas },
        viewportRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        projectionAnchor: active.viewport,
      }],
    };
  }

  getVisiblePages(): readonly ReadingPageReference[] {
    return this.readVisibleSpread().pages.map(({ identity }) => ({
      key: this.pageKey(identity.pageIndex),
      originalUrl: this.pageReference(identity.pageIndex),
      pageIndex: identity.pageIndex,
    }));
  }

  async discoverReadingPages() {
    return {
      status: 'incomplete' as const,
      reason: 'unsupported-format' as const,
      detail: 'PUBLUS 的完整页序与页面恢复依赖阅读器内部解包状态；当前边界仅支持翻译当前显示页',
    };
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
    anchor.dataset.mtReaderEngineUi = this.engineId;
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
    const pageIndex = parseCurrentPageIndex(this.document);
    const active = this.readActiveSurface();
    if (pageIndex === null || !active || this.pageKey(pageIndex) !== key) return;
    const projections = [
      ...active.viewport.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]'),
    ];
    if (url === this.pageReference(pageIndex)) {
      for (const projection of projections) projection.remove();
      return;
    }
    const image = projections[0] ?? this.document.createElement('img');
    for (const duplicate of projections.slice(1)) duplicate.remove();
    image.dataset.mtReadingProjection = '';
    image.alt = '';
    image.src = url;
    image.style.position = 'absolute';
    image.style.pointerEvents = 'none';
    image.style.zIndex = '2147483645';
    image.style.objectFit = 'fill';
    if (image.parentElement !== active.viewport) active.viewport.appendChild(image);
    const viewportRect = active.viewport.getBoundingClientRect();
    const canvasRect = active.canvas.getBoundingClientRect();
    image.style.left = `${canvasRect.left - viewportRect.left}px`;
    image.style.top = `${canvasRect.top - viewportRect.top}px`;
    image.style.width = `${canvasRect.width}px`;
    image.style.height = `${canvasRect.height}px`;
  }

  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void {
    if (this.disposed) return () => undefined;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => onSignal({ kind: 'geometry-changed' }));
    resizeObserver?.observe(this.root);
    resizeObserver?.observe(this.renderer);
    for (const canvas of this.renderer.querySelectorAll(canvasSelector)) resizeObserver?.observe(canvas);
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          if (records.every(mutationOnlyTouchesExtensionNodes)) return;
          onSignal({ kind: 'navigation-state-changed' });
        });
    mutationObserver?.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'width', 'height'],
    });
    const onTransitionEnd = (): void => onSignal({ kind: 'render-settled' });
    const onGeometry = (): void => onSignal({ kind: 'geometry-changed' });
    this.root.addEventListener('transitionend', onTransitionEnd);
    this.document.addEventListener('fullscreenchange', onGeometry);
    this.window.addEventListener('resize', onGeometry, { passive: true });
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      this.root.removeEventListener('transitionend', onTransitionEnd);
      this.document.removeEventListener('fullscreenchange', onGeometry);
      this.window.removeEventListener('resize', onGeometry);
      this.observerStops.delete(stop);
    };
    this.observerStops.add(stop);
    return stop;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of [...this.observerStops]) stop();
    this.bottomBarAnchor?.remove();
    this.bottomBarAnchor = null;
    for (const projection of this.root.querySelectorAll('[data-mt-reading-projection]')) {
      projection.remove();
    }
  }
}

class PublusReaderAdapter implements ReaderEngineAdapter {
  readonly engineId = 'publus-reader';

  constructor(private readonly dependencies: PublusReaderDependencies) {}

  detect(): ReaderEngineDetection | null {
    const root = this.dependencies.document.querySelector<HTMLElement>(rootSelector);
    if (!root || !hasPublusImageReaderScript(this.dependencies.document)) return null;
    const config = readDetectionConfig(root, this.dependencies);
    if (
      !config
      || !config.renderer.querySelector(canvasSelector)
      || !this.dependencies.document.querySelector(counterSelector)
      || parseCurrentPageIndex(this.dependencies.document) === null
    ) {
      return null;
    }
    return {
      confidence: 'strong',
      root,
      sessionAnchor: config.renderer,
      contextKey: config.contextKey,
      evidence: [
        'PUBLUS viewer_image script',
        `${rootSelector} ${rendererSelector}`,
        '#viewport0/#viewport1/#viewportW canvas',
        counterSelector,
      ],
    };
  }

  createSession(detection: ReaderEngineDetection): ReaderEngineSession {
    return this.createReaderSession(detection);
  }

  createReadingModeSession(detection: ReaderEngineDetection): ReaderEngineReadingModeSession {
    return this.createReaderSession(detection);
  }

  private createReaderSession(detection: ReaderEngineDetection): PublusReaderSession {
    const config = readDetectionConfig(detection.root, this.dependencies);
    if (
      !config
      || detection.sessionAnchor !== config.renderer
      || detection.contextKey !== config.contextKey
    ) {
      throw new Error('Invalid PUBLUS Reader detection');
    }
    return new PublusReaderSession(
      detection.root,
      config.renderer,
      this.dependencies.document,
      this.dependencies.window,
      config,
    );
  }
}

export function createPublusReaderAdapter(
  dependencies: PublusReaderDependencies = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
  },
): ReaderEngineAdapter {
  return new PublusReaderAdapter(dependencies);
}
