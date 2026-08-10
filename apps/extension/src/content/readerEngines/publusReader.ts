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
  createPublusReaderContentClient,
  PublusReaderInvalidResponseError,
  PublusReaderUnsupportedError,
  type PublusObservedSession,
  type PublusReaderManifest,
  type PublusReaderContentClient,
  type PublusReaderResourceFetcher,
  type RestorePublusV1Image,
} from './publusReaderContent';

const rootSelector = '#viewer.viewer, #viewer';
const rendererSelector = '#renderer';
const counterSelector = '#pageSliderCounter';
const canvasSelector = '#viewport0 canvas, #viewport1 canvas, #viewportW canvas';

type PublusLocation = Pick<Location, 'href'>;

export type PublusReaderDependencies = {
  document: Document;
  window: Window;
  location: PublusLocation;
  createContentClient?: (options: {
    readObservedSession: () => PublusObservedSession | null;
  }) => PublusReaderContentClient;
  fetchResource?: PublusReaderResourceFetcher;
  downloadImage?: DownloadImageForTranslation;
  restoreImage?: RestorePublusV1Image;
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

function readPublusProtocolMajor(document: Document): 1 | 2 | null {
  for (const script of [...document.scripts]) {
    const match = /\/viewer_image_([12])\.[^/]*\.js(?:\?|$)/iu.exec(script.src);
    if (match?.[1] === '1') return 1;
    if (match?.[1] === '2') return 2;
  }
  return null;
}

function parseObservedHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function readObservedSession(
  document: Document,
  window: Window,
  location: PublusLocation,
): PublusObservedSession | null {
  const viewer = parseObservedHttpsUrl(location.href);
  const cid = viewer?.searchParams.get('cid');
  const protocolMajor = readPublusProtocolMajor(document);
  if (!viewer || !cid || !protocolMajor) return null;
  const resources = (window.performance?.getEntriesByType?.('resource') ?? [])
    .map((entry, order) => ({ url: parseObservedHttpsUrl(entry.name), order }))
    .filter((entry): entry is { url: URL; order: number } => entry.url !== null);
  const configuration = [...resources]
    .reverse()
    .find(({ url }) => /\/configuration_pack\.json$/u.test(url.pathname));
  if (!configuration) return null;
  const contentCheck = [...resources]
    .reverse()
    .find(({ url, order }) => (
      order < configuration.order
      && url.searchParams.get('cid') === cid
      && !/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|woff2?)(?:$|\/)/iu.test(url.pathname)
    ));
  if (!contentCheck) return null;
  return {
    viewerUrl: viewer.href,
    contentCheckUrl: contentCheck.url.href,
    configurationUrl: configuration.url.href,
    protocolMajor,
  };
}

function createRuntimePublusResourceFetcher(): PublusReaderResourceFetcher {
  return async (request, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    const response = await sendRuntimeMessage({
      type: 'mt:fetch-reader-resource',
      url: request.url,
      allowedBaseUrl: request.allowedBaseUrl,
    });
    if (options?.signal?.aborted) throw options.signal.reason;
    if (!response.ok || response.type !== 'mt:fetch-reader-resource') {
      throw new Error(response.ok ? 'PUBLUS 阅读器资源请求失败' : response.error);
    }
    return {
      text: response.text,
      contentType: response.contentType,
      sourceUrl: response.sourceUrl,
    };
  };
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
  private readonly contentClient: PublusReaderContentClient;
  private manifest: PublusReaderManifest | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly renderer: HTMLElement,
    private readonly document: Document,
    private readonly window: Window,
    config: PublusDetectionConfig,
    private readonly dependencies: PublusReaderDependencies,
  ) {
    this.contextKey = config.contextKey;
    const readSession = () => readObservedSession(
      this.document,
      this.window,
      this.dependencies.location,
    );
    this.contentClient = dependencies.createContentClient?.({
      readObservedSession: readSession,
    }) ?? createPublusReaderContentClient({
      readObservedSession: readSession,
      fetchResource: dependencies.fetchResource ?? createRuntimePublusResourceFetcher(),
      downloadImage: dependencies.downloadImage
        ?? createRuntimeImageDownloader(sendRuntimeMessage),
      document: this.document,
      restoreImage: dependencies.restoreImage,
    });
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
    return this.readVisibleReadingPageIndexes().map((pageIndex) => ({
      key: this.pageKey(pageIndex),
      originalUrl: this.pageReference(pageIndex),
      pageIndex,
    }));
  }

  private readVisibleReadingPageIndexes(
    active = this.readActiveSurface(),
  ): readonly number[] {
    const currentPageIndex = parseCurrentPageIndex(this.document);
    if (currentPageIndex === null || !active) return [];
    const manifest = this.manifest;
    const currentPage = manifest?.pages[currentPageIndex];
    const canvasRect = active.canvas.getBoundingClientRect();
    if (
      !manifest
      || !currentPage
      || canvasRect.width <= canvasRect.height
      || currentPage.width >= currentPage.height
    ) {
      return [currentPageIndex];
    }

    let pageIndex = 0;
    while (pageIndex < manifest.pages.length) {
      const page = manifest.pages[pageIndex]!;
      if (pageIndex === 0 || page.width >= page.height) {
        if (pageIndex === currentPageIndex) return [pageIndex];
        pageIndex += 1;
        continue;
      }
      const next = manifest.pages[pageIndex + 1];
      const members = next && next.width < next.height
        ? [pageIndex, pageIndex + 1]
        : [pageIndex];
      if (members.includes(currentPageIndex)) return members;
      pageIndex += members.length;
    }
    return [currentPageIndex];
  }

  private readProjectionLayout(
    pageIndex: number,
    active: { canvas: HTMLCanvasElement; viewport: HTMLElement },
    visiblePageIndexes: readonly number[],
  ): { rect: DOMRect; objectPosition: 'center center' | 'left center' | 'right center' } {
    const canvasRect = active.canvas.getBoundingClientRect();
    const manifest = this.manifest;
    const page = manifest?.pages[pageIndex];
    if (
      !manifest
      || !page
      || canvasRect.width <= canvasRect.height
      || page.width >= page.height
    ) {
      return { rect: canvasRect, objectPosition: 'center center' };
    }

    let side: 'left' | 'right';
    if (visiblePageIndexes.length === 2) {
      const memberIndex = visiblePageIndexes.indexOf(pageIndex);
      side = manifest.direction === 'rtl'
        ? (memberIndex === 0 ? 'right' : 'left')
        : (memberIndex === 0 ? 'left' : 'right');
    } else {
      const oddPhysicalPage = pageIndex % 2 === 0;
      side = manifest.direction === 'rtl'
        ? (oddPhysicalPage ? 'left' : 'right')
        : (oddPhysicalPage ? 'right' : 'left');
    }

    const width = canvasRect.width / 2;
    const left = canvasRect.left + (side === 'right' ? width : 0);
    return {
      objectPosition: side === 'left' ? 'right center' : 'left center',
      rect: {
        left,
        right: left + width,
        width,
        x: left,
        top: canvasRect.top,
        bottom: canvasRect.bottom,
        y: canvasRect.top,
        height: canvasRect.height,
        toJSON: () => ({}),
      },
    };
  }

  async discoverReadingPages(signal?: AbortSignal) {
    try {
      const current = readDetectionConfig(this.root, this.dependencies);
      if (!current || current.contextKey !== this.contextKey) {
        return { status: 'incomplete' as const, reason: 'metadata-unavailable' as const };
      }
      const manifest = await this.contentClient.read({ signal });
      this.manifest = manifest;
      return {
        status: 'complete' as const,
        pages: Array.from({ length: manifest.pageCount }, (_, pageIndex) => ({
          key: this.pageKey(pageIndex),
          originalUrl: this.pageReference(pageIndex),
          pageIndex,
        })),
      };
    } catch (error) {
      if (error instanceof PublusReaderUnsupportedError) {
        return {
          status: 'incomplete' as const,
          reason: 'unsupported-format' as const,
          detail: error.message,
        };
      }
      return {
        status: 'incomplete' as const,
        reason: error instanceof PublusReaderInvalidResponseError
          ? 'invalid-response' as const
          : 'request-failed' as const,
      };
    }
  }

  async prepareReadingPage(page: ReadingPageReference, signal: AbortSignal) {
    if (!Number.isSafeInteger(page.pageIndex) || Number(page.pageIndex) < 0) {
      throw new Error('PUBLUS 阅读页缺少物理页序号');
    }
    const current = readDetectionConfig(this.root, this.dependencies);
    if (!current || current.contextKey !== this.contextKey) {
      throw new Error('PUBLUS 阅读上下文已变化');
    }
    this.manifest ??= await this.contentClient.read({ signal });
    const file = await this.contentClient.acquirePublusPageFile(Number(page.pageIndex), signal);
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
    const active = this.readActiveSurface();
    if (!active) return;
    const visiblePageIndexes = this.readVisibleReadingPageIndexes(active);
    const pageIndex = visiblePageIndexes.find((index) => this.pageKey(index) === key);
    if (pageIndex === undefined) return;
    const projections = [
      ...active.viewport.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]'),
    ];
    const visibleKeys = new Set(visiblePageIndexes.map((index) => this.pageKey(index)));
    for (const projection of projections) {
      if (!visibleKeys.has(projection.dataset.mtReadingProjectionKey ?? '')) projection.remove();
    }
    const matching = projections.filter((projection) => (
      projection.dataset.mtReadingProjectionKey === key && projection.parentElement === active.viewport
    ));
    if (url === this.pageReference(pageIndex)) {
      for (const projection of matching) projection.remove();
      return;
    }
    const image = matching[0] ?? this.document.createElement('img');
    for (const duplicate of matching.slice(1)) duplicate.remove();
    image.dataset.mtReadingProjection = '';
    image.dataset.mtReadingProjectionKey = key;
    image.alt = '';
    image.src = url;
    image.style.position = 'absolute';
    image.style.pointerEvents = 'none';
    image.style.zIndex = '2147483645';
    image.style.objectFit = 'contain';
    if (image.parentElement !== active.viewport) active.viewport.appendChild(image);
    const viewportRect = active.viewport.getBoundingClientRect();
    const projection = this.readProjectionLayout(pageIndex, active, visiblePageIndexes);
    const projectionRect = projection.rect;
    image.style.objectPosition = projection.objectPosition;
    image.style.left = `${projectionRect.left - viewportRect.left}px`;
    image.style.top = `${projectionRect.top - viewportRect.top}px`;
    image.style.width = `${projectionRect.width}px`;
    image.style.height = `${projectionRect.height}px`;
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
    if (!root || !readPublusProtocolMajor(this.dependencies.document)) return null;
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
      this.dependencies,
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
