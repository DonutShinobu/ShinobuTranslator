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
  acquireBinbPageFile,
  BinbInvalidResponseError,
  BinbUnsupportedError,
  createBinbContentClient,
  createBinbContextKey,
  identifyBinbImageQuality,
  restoreBinbPageImage,
  type BinbContentClient,
  type BinbManifest,
  type BinbResourceFetcher,
} from './binbContent';

const rootSelector = '#content[data-ptbinb]';
const directSlotSelector = ':scope > [data-ptimg]';
const renderedSlotSelector = ':scope > [data-ptimg] > .pt-img';
const translateAllPageLimit = 200;

type BinbLocation = Pick<Location, 'href' | 'origin' | 'pathname' | 'search'>;

export type CreateBinbContentClient = (options: {
  cid: string;
  metadataUrl: string;
  readerUrl: string;
}) => BinbContentClient;

export type BinbReaderEngineDependencies = {
  document: Document;
  window: Window;
  location: BinbLocation;
  createContentClient?: CreateBinbContentClient;
  fetchResource?: BinbResourceFetcher;
  downloadImage?: DownloadImageForTranslation;
  restoreImage?: typeof restoreBinbPageImage;
  randomBlock?: () => string;
  now?: () => number;
};

type BinbDetectionConfig = {
  cid: string;
  metadataUrl: string;
  contextKey: string;
};

function readDetectionConfig(root: HTMLElement, location: BinbLocation): BinbDetectionConfig | null {
  const endpoint = root.getAttribute('data-ptbinb');
  if (!endpoint) return null;
  let readerUrl: URL;
  let metadataUrl: URL;
  try {
    readerUrl = new URL(location.href);
    metadataUrl = new URL(endpoint, readerUrl);
  } catch {
    return null;
  }
  if (
    readerUrl.protocol !== 'https:'
    || metadataUrl.protocol !== 'https:'
    || metadataUrl.origin !== readerUrl.origin
    || metadataUrl.username
    || metadataUrl.password
  ) {
    return null;
  }
  const cid = root.getAttribute('data-ptbinb-cid') || readerUrl.searchParams.get('cid');
  if (!cid) return null;
  return {
    cid,
    metadataUrl: metadataUrl.href,
    contextKey: createBinbContextKey(cid, readerUrl.href),
  };
}

function parsePhysicalPageIndex(slot: HTMLElement): number | null {
  const match = /^content-p(\d+)$/u.exec(slot.id);
  if (!match) return null;
  const pageNumber = Number(match[1]);
  return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : null;
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

function createRuntimeBinbResourceFetcher(): BinbResourceFetcher {
  return async (request, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    const response = await sendRuntimeMessage({
      type: 'mt:fetch-reader-resource',
      url: request.url,
      allowedBaseUrl: request.allowedBaseUrl,
    });
    if (options?.signal?.aborted) throw options.signal.reason;
    if (!response.ok || response.type !== 'mt:fetch-reader-resource') {
      throw new Error(response.ok ? 'BinB 阅读器资源请求失败' : response.error);
    }
    return {
      text: response.text,
      contentType: response.contentType,
      sourceUrl: response.sourceUrl,
    };
  };
}

class BinbReaderEngineSession implements ReaderEngineReadingModeSession {
  readonly engineId = 'binb';
  readonly contextKey: string;
  private readonly client: BinbContentClient;
  private readonly downloadImage: DownloadImageForTranslation;
  private readonly restoreImage: typeof restoreBinbPageImage;
  private readonly observers = new Set<() => void>();
  private bottomBarAnchor: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly document: Document,
    private readonly window: Window,
    config: BinbDetectionConfig,
    private readonly dependencies: BinbReaderEngineDependencies,
  ) {
    this.contextKey = config.contextKey;
    const fetchResource = dependencies.fetchResource ?? createRuntimeBinbResourceFetcher();
    this.client = dependencies.createContentClient?.({
      cid: config.cid,
      metadataUrl: config.metadataUrl,
      readerUrl: dependencies.location.href,
    }) ?? createBinbContentClient({
      cid: config.cid,
      metadataUrl: config.metadataUrl,
      readerUrl: dependencies.location.href,
      fetchResource,
      randomBlock: dependencies.randomBlock,
      now: dependencies.now,
    });
    this.downloadImage = dependencies.downloadImage
      ?? createRuntimeImageDownloader(sendRuntimeMessage);
    this.restoreImage = dependencies.restoreImage ?? restoreBinbPageImage;
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

  private readMountedSlots(): Array<{
    slot: HTMLElement;
    surface: HTMLElement;
    pageIndex: number;
  }> {
    if (!this.root.isConnected) return [];
    const seen = new Set<number>();
    const mounted: Array<{ slot: HTMLElement; surface: HTMLElement; pageIndex: number }> = [];
    for (const slot of this.root.querySelectorAll<HTMLElement>(directSlotSelector)) {
      const pageIndex = parsePhysicalPageIndex(slot);
      const surface = slot.querySelector<HTMLElement>('.pt-img');
      if (pageIndex === null || seen.has(pageIndex) || !surface?.isConnected) continue;
      seen.add(pageIndex);
      mounted.push({ slot, surface, pageIndex });
    }
    return mounted.sort((left, right) => left.pageIndex - right.pageIndex);
  }

  readVisibleSpread(): ReaderVisibleSpread {
    const pages = this.readMountedSlots()
      .map(({ slot, surface, pageIndex }) => {
        const surfaceRect = surface.getBoundingClientRect();
        if (
          surfaceRect.width <= 0
          || surfaceRect.height <= 0
          || intersectionArea(surfaceRect, this.window.innerWidth, this.window.innerHeight) <= 0
        ) {
          return null;
        }
        return {
          identity: { engineId: this.engineId, contextKey: this.contextKey, pageIndex },
          slot,
          source: { kind: 'viewport-region' as const },
          viewportRect: {
            left: surfaceRect.left,
            top: surfaceRect.top,
            width: surfaceRect.width,
            height: surfaceRect.height,
          },
          projectionAnchor: surface,
        };
      })
      .filter((page): page is NonNullable<typeof page> => page !== null);
    return { pages };
  }

  getVisiblePages(): readonly ReadingPageReference[] {
    return this.readVisibleSpread().pages.map(({ identity }) => ({
      key: this.pageKey(identity.pageIndex),
      originalUrl: this.pageReference(identity.pageIndex),
      pageIndex: identity.pageIndex,
    }));
  }

  private async readCurrentManifest(signal?: AbortSignal): Promise<BinbManifest> {
    try {
      return await this.client.read({ signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof BinbUnsupportedError) throw error;
      const current = readDetectionConfig(this.root, this.dependencies.location);
      if (!current || current.contextKey !== this.contextKey) {
        throw new Error('BinB 阅读上下文已变化');
      }
      return this.client.read({ forceRefresh: true, signal });
    }
  }

  async discoverReadingPages(signal?: AbortSignal) {
    try {
      const manifest = await this.readCurrentManifest(signal);
      if (createBinbContextKey(manifest.cid, manifest.readerUrl) !== this.contextKey) {
        return { status: 'incomplete' as const, reason: 'metadata-unavailable' as const };
      }
      if (manifest.pages.length > translateAllPageLimit) {
        return {
          status: 'incomplete' as const,
          reason: 'page-limit-exceeded' as const,
          pageCount: manifest.pages.length,
          maxPages: translateAllPageLimit,
        };
      }
      return {
        status: 'complete' as const,
        pages: manifest.pages.map(({ pageIndex }) => ({
          key: this.pageKey(pageIndex),
          originalUrl: this.pageReference(pageIndex),
          pageIndex,
        })),
      };
    } catch (error) {
      if (error instanceof BinbUnsupportedError) {
        return {
          status: 'incomplete' as const,
          reason: 'unsupported-format' as const,
          detail: error.message,
        };
      }
      return {
        status: 'incomplete' as const,
        reason: error instanceof BinbInvalidResponseError
          ? 'invalid-response' as const
          : 'request-failed' as const,
      };
    }
  }

  private readRenderedQuality(manifest: BinbManifest): 'low' | 'high' {
    if (manifest.imageClass === 'singlequality') return 'low';
    const resourceEntries = this.window.performance?.getEntriesByType?.('resource') ?? [];
    for (let index = resourceEntries.length - 1; index >= 0; index -= 1) {
      const name = resourceEntries[index]?.name;
      if (!name) continue;
      const quality = identifyBinbImageQuality(manifest, name);
      if (quality) return quality;
    }
    for (const { surface, pageIndex } of this.readMountedSlots()) {
      const page = manifest.pages[pageIndex];
      if (!page) continue;
      const widths = [...surface.querySelectorAll<HTMLImageElement>('img')]
        .map((image) => image.naturalWidth || image.width || Number(image.getAttribute('width')) || 0);
      const renderedWidth = Math.max(0, ...widths);
      if (renderedWidth > 0) return renderedWidth >= page.width * 0.75 ? 'high' : 'low';
    }
    return 'low';
  }

  async prepareReadingPage(page: ReadingPageReference, signal: AbortSignal) {
    if (!Number.isInteger(page.pageIndex) || Number(page.pageIndex) < 0) {
      throw new Error('BinB 阅读页缺少物理页序号');
    }
    const manifest = await this.readCurrentManifest(signal);
    if (createBinbContextKey(manifest.cid, manifest.readerUrl) !== this.contextKey) {
      throw new Error('BinB 阅读上下文已变化');
    }
    const file = await acquireBinbPageFile(
      Number(page.pageIndex),
      this.contextKey,
      this.client,
      this.readRenderedQuality(manifest),
      this.downloadImage,
      this.restoreImage,
      signal,
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
    anchor.dataset.mtReaderEngineUi = 'binb';
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
    const mounted = this.readMountedSlots().find(({ pageIndex }) => this.pageKey(pageIndex) === key);
    if (!mounted) return;
    const projections = [
      ...mounted.slot.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]'),
    ];
    if (url === this.pageReference(mounted.pageIndex)) {
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
    image.style.zIndex = '2';
    image.style.objectFit = 'fill';
    if (image.parentElement !== mounted.slot) mounted.slot.appendChild(image);
    const slotRect = mounted.slot.getBoundingClientRect();
    const surfaceRect = mounted.surface.getBoundingClientRect();
    image.style.left = `${surfaceRect.left - slotRect.left}px`;
    image.style.top = `${surfaceRect.top - slotRect.top}px`;
    image.style.width = `${surfaceRect.width}px`;
    image.style.height = `${surfaceRect.height}px`;
  }

  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void {
    if (this.disposed) return () => undefined;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => onSignal({ kind: 'geometry-changed' }));
    const resizeTargets = new Set<Element>();
    const syncResizeTargets = (): void => {
      const current = new Set<Element>([this.root]);
      for (const { slot, surface } of this.readMountedSlots()) {
        current.add(slot);
        current.add(surface);
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
          if (records.every(mutationOnlyTouchesExtensionNodes)) return;
          syncResizeTargets();
          onSignal({ kind: 'structure-changed' });
        });
    mutationObserver?.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['id', 'class', 'style', 'width', 'height', 'data-ptimg'],
    });
    const onTransitionEnd = (): void => onSignal({ kind: 'render-settled' });
    const onScroll = (): void => onSignal({ kind: 'navigation-state-changed' });
    const onGeometry = (): void => onSignal({ kind: 'geometry-changed' });
    this.root.addEventListener('transitionend', onTransitionEnd);
    this.document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    this.document.addEventListener('fullscreenchange', onGeometry);
    this.window.addEventListener('resize', onGeometry, { passive: true });
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      this.root.removeEventListener('transitionend', onTransitionEnd);
      this.document.removeEventListener('scroll', onScroll, true);
      this.document.removeEventListener('fullscreenchange', onGeometry);
      this.window.removeEventListener('resize', onGeometry);
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

class BinbReaderEngineAdapter implements ReaderEngineAdapter {
  readonly engineId = 'binb';

  constructor(private readonly dependencies: BinbReaderEngineDependencies) {}

  detect(): ReaderEngineDetection | null {
    const root = this.dependencies.document.querySelector<HTMLElement>(rootSelector);
    if (!root || !root.querySelector(renderedSlotSelector)) return null;
    const config = readDetectionConfig(root, this.dependencies.location);
    if (!config) return null;
    const hasPhysicalSlot = [...root.querySelectorAll<HTMLElement>(directSlotSelector)]
      .some((slot) => parsePhysicalPageIndex(slot) !== null && slot.querySelector('.pt-img'));
    if (!hasPhysicalSlot) return null;
    return {
      confidence: 'strong',
      root,
      sessionAnchor: root,
      contextKey: config.contextKey,
      evidence: [
        rootSelector,
        'same-origin HTTPS bibGetCntntInfo',
        renderedSlotSelector,
        'content-pN physical ordinal',
      ],
    };
  }

  createReadingModeSession(detection: ReaderEngineDetection): ReaderEngineReadingModeSession {
    return this.createReaderSession(detection);
  }

  private createReaderSession(detection: ReaderEngineDetection): BinbReaderEngineSession {
    const config = readDetectionConfig(detection.root, this.dependencies.location);
    if (
      !config
      || detection.sessionAnchor !== detection.root
      || detection.contextKey !== config.contextKey
    ) {
      throw new Error('Invalid BinB detection');
    }
    return new BinbReaderEngineSession(
      detection.root,
      this.dependencies.document,
      this.dependencies.window,
      config,
      this.dependencies,
    );
  }
}

export function createBinbReaderEngineAdapter(
  dependencies: BinbReaderEngineDependencies = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
  },
): ReaderEngineAdapter {
  return new BinbReaderEngineAdapter(dependencies);
}
