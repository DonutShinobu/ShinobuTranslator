import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
  ReaderEngineReadingModeSession,
  ReaderEngineSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../core/continuous/contracts';
import type { ReadingPageReference } from '../core/types';
import {
  createRuntimeImageDownloader,
  type DownloadImageForTranslation,
} from '../core/translation/imageTranslationExecution';
import { sendRuntimeMessage } from '../../shared/messages';
import {
  acquireClipStudioReaderSpreadFile,
  ClipStudioReaderInvalidResponseError,
  ClipStudioReaderUnsupportedError,
  createClipStudioReaderContentClient,
  type ClipStudioReaderContentClient,
  type ClipStudioReaderManifest,
  type ClipStudioReaderResourceFetcher,
  type ClipStudioReaderSpread,
} from './clipStudioReaderContent';

const rootSelector = '#stage';
const screenLayerSelector = '#screen_layer';
const currentCounterSelector = '#menu_nombre_current';
const totalCounterSelector = '#menu_nombre_total';
const translateAllPageLimit = 200;

type ClipStudioLocation = Pick<Location, 'href'>;

type ClipStudioReaderDetectionConfig = {
  contextKey: string;
  requestTemplateUrl: string;
  screenLayer: HTMLElement;
};

export type CreateClipStudioReaderContentClient = (options: {
  templateUrl: string;
}) => ClipStudioReaderContentClient;

type PrepareClipStudioSpread = typeof acquireClipStudioReaderSpreadFile;

export type ClipStudioReaderDependencies = {
  document: Document;
  window: Window;
  location: ClipStudioLocation;
  createContentClient?: CreateClipStudioReaderContentClient;
  fetchResource?: ClipStudioReaderResourceFetcher;
  downloadImage?: DownloadImageForTranslation;
  prepareSpread?: PrepareClipStudioSpread;
  now?: () => number;
};

function hashIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeContextUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    for (const volatileKey of ['time', 'dmytime', '_']) url.searchParams.delete(volatileKey);
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function readObservedRequestTemplate(window: Window): string | null {
  const entries = window.performance?.getEntriesByType?.('resource') ?? [];
  const candidates: Array<{ url: string; rank: number }> = [];
  for (const entry of entries) {
    try {
      const url = new URL(entry.name);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || !url.searchParams.has('mode')
        || !url.searchParams.has('file')
      ) {
        continue;
      }
      const mode = url.searchParams.get('mode');
      const file = url.searchParams.get('file');
      const rank = mode === '7' && file === 'face.xml'
        ? 3
        : mode === '8' && /^\d{4}\.xml$/u.test(file ?? '')
          ? 2
          : mode === '1' && /\.bin$/u.test(file ?? '')
            ? 1
            : 0;
      if (rank > 0) candidates.push({ url: url.href, rank });
    } catch {
      // Ignore malformed performance entries owned by the page.
    }
  }
  candidates.sort((left, right) => right.rank - left.rank);
  return candidates[0]?.url ?? null;
}

function hasClipStudioScripts(document: Document): boolean {
  const sources = [...document.scripts].map((script) => script.src).filter(Boolean);
  return sources.some((source) => /\/(?:csr-web-(?:core|player-hybrid)|csrh-standard-viewer)\.js(?:\?|$)/iu.test(source));
}

function readDetectionConfig(
  root: HTMLElement,
  dependencies: ClipStudioReaderDependencies,
): ClipStudioReaderDetectionConfig | null {
  const screenLayer = root.querySelector<HTMLElement>(screenLayerSelector);
  const templateUrl = readObservedRequestTemplate(dependencies.window);
  const normalizedViewerUrl = normalizeContextUrl(dependencies.location.href);
  const normalizedTemplateUrl = templateUrl ? normalizeContextUrl(templateUrl) : null;
  if (!screenLayer || !templateUrl || !normalizedViewerUrl || !normalizedTemplateUrl) return null;
  const contextHash = hashIdentity(`${normalizedViewerUrl}\n${normalizedTemplateUrl}`);
  return {
    contextKey: `clip-studio-reader:${new URL(normalizedViewerUrl).origin}${new URL(normalizedViewerUrl).pathname}:${contextHash}`,
    requestTemplateUrl: templateUrl,
    screenLayer,
  };
}

function parseCounter(document: Document, selector: string): number | null {
  const text = document.querySelector(selector)?.textContent ?? '';
  const match = /\d+/u.exec(text);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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

function createRuntimeResourceFetcher(): ClipStudioReaderResourceFetcher {
  return async (request, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    const response = await sendRuntimeMessage({
      type: 'mt:fetch-reader-resource',
      url: request.url,
      allowedBaseUrl: request.allowedBaseUrl,
    });
    if (options?.signal?.aborted) throw options.signal.reason;
    if (!response.ok || response.type !== 'mt:fetch-reader-resource') {
      throw new Error(response.ok ? 'CLIP 阅读器资源请求失败' : response.error);
    }
    return {
      text: response.text,
      contentType: response.contentType,
      sourceUrl: response.sourceUrl,
    };
  };
}

class ClipStudioReaderSession implements ReaderEngineReadingModeSession {
  readonly engineId = 'clip-studio-reader';
  readonly contextKey: string;
  private readonly client: ClipStudioReaderContentClient;
  private readonly downloadImage: DownloadImageForTranslation;
  private readonly prepareSpread: PrepareClipStudioSpread;
  private readonly observerStops = new Set<() => void>();
  private readonly signalListeners = new Set<(signal: ReaderSessionSignal) => void>();
  private manifest: ClipStudioReaderManifest | null = null;
  private manifestError: unknown;
  private manifestPromise: Promise<ClipStudioReaderManifest>;
  private bottomBarAnchor: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly screenLayer: HTMLElement,
    private readonly document: Document,
    private readonly window: Window,
    config: ClipStudioReaderDetectionConfig,
    dependencies: ClipStudioReaderDependencies,
  ) {
    this.contextKey = config.contextKey;
    const fetchResource = dependencies.fetchResource ?? createRuntimeResourceFetcher();
    this.client = dependencies.createContentClient?.({ templateUrl: config.requestTemplateUrl })
      ?? createClipStudioReaderContentClient({
        templateUrl: config.requestTemplateUrl,
        fetchResource,
        now: dependencies.now,
        pageLimit: translateAllPageLimit,
      });
    this.downloadImage = dependencies.downloadImage
      ?? createRuntimeImageDownloader(sendRuntimeMessage);
    this.prepareSpread = dependencies.prepareSpread ?? acquireClipStudioReaderSpreadFile;
    this.manifestPromise = this.loadManifest();
  }

  private async loadManifest(forceRefresh = false, signal?: AbortSignal): Promise<ClipStudioReaderManifest> {
    try {
      const manifest = await this.client.read({ forceRefresh, signal });
      this.manifest = manifest;
      this.manifestError = undefined;
      if (!this.disposed) {
        for (const listener of this.signalListeners) listener({ kind: 'structure-changed' });
      }
      return manifest;
    } catch (error) {
      this.manifestError = error;
      throw error;
    }
  }

  getReadingContextKey(): string {
    return this.contextKey;
  }

  private pageKey(pageIndex: number): string {
    return `${this.contextKey}:spread:${pageIndex}`;
  }

  private pageReference(pageIndex: number): string {
    return `engine-source:${this.pageKey(pageIndex)}`;
  }

  private readActiveCanvas(): HTMLCanvasElement | null {
    const candidates = [...this.screenLayer.querySelectorAll<HTMLCanvasElement>('canvas')]
      .map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const style = this.window.getComputedStyle?.(canvas);
        const visible = canvas.isConnected
          && rect.width > 0
          && rect.height > 0
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && Number(style?.opacity ?? '1') > 0;
        return {
          canvas,
          visible,
          area: intersectionArea(rect, this.window.innerWidth, this.window.innerHeight),
          zIndex: Number(style?.zIndex ?? canvas.style.zIndex ?? 0) || 0,
        };
      })
      .filter((candidate) => candidate.visible && candidate.area > 0)
      .sort((left, right) => right.zIndex - left.zIndex || right.area - left.area);
    return candidates[0]?.canvas ?? null;
  }

  private currentSpread(manifest = this.manifest): ClipStudioReaderSpread | null {
    if (!manifest) return null;
    const currentPageNumber = parseCounter(this.document, currentCounterSelector);
    if (!currentPageNumber) return null;
    const singleIndex = currentPageNumber - 1;
    return manifest.spreads.find((spread) => (
      singleIndex >= spread.singleStartIndex
      && singleIndex < spread.singleStartIndex + spread.singleCount
    )) ?? null;
  }

  readVisibleSpread(): ReaderVisibleSpread {
    const spread = this.currentSpread();
    const canvas = this.readActiveCanvas();
    if (!spread || !canvas) return { pages: [] };
    const rect = canvas.getBoundingClientRect();
    return {
      pages: [{
        identity: { engineId: this.engineId, contextKey: this.contextKey, pageIndex: spread.pageIndex },
        slot: this.screenLayer,
        source: { kind: 'canvas', element: canvas },
        viewportRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        projectionAnchor: this.screenLayer,
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

  async discoverReadingPages(signal?: AbortSignal) {
    try {
      const manifest = this.manifest ?? await this.manifestPromise;
      if (signal?.aborted) throw signal.reason;
      return {
        status: 'complete' as const,
        pages: manifest.spreads.map((spread) => ({
          key: this.pageKey(spread.pageIndex),
          originalUrl: this.pageReference(spread.pageIndex),
          pageIndex: spread.pageIndex,
        })),
      };
    } catch (error) {
      if (error instanceof ClipStudioReaderUnsupportedError) {
        return { status: 'incomplete' as const, reason: 'unsupported-format' as const, detail: error.message };
      }
      return {
        status: 'incomplete' as const,
        reason: error instanceof ClipStudioReaderInvalidResponseError
          ? 'invalid-response' as const
          : 'request-failed' as const,
      };
    }
  }

  async prepareReadingPage(page: ReadingPageReference, signal: AbortSignal) {
    if (!Number.isSafeInteger(page.pageIndex) || Number(page.pageIndex) < 0) {
      throw new Error('CLIP 阅读页缺少跨页序号');
    }
    const manifest = this.manifest ?? await this.manifestPromise;
    const spread = manifest.spreads[Number(page.pageIndex)];
    if (!spread) throw new Error('CLIP 阅读页不存在');
    const file = await this.prepareSpread({
      spread,
      manifest,
      client: this.client,
      downloadImage: this.downloadImage,
      document: this.document,
      signal,
    });
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

  private readProjectionViewport(canvas: HTMLCanvasElement): DOMRect {
    const canvasRect = canvas.getBoundingClientRect();
    try {
      if (canvas.width <= 0 || canvas.height <= 0) return canvasRect;
      const context = canvas.getContext('2d');
      if (!context) return canvasRect;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width;
      let top = canvas.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        const rowOffset = y * canvas.width * 4;
        for (let x = 0; x < canvas.width; x += 1) {
          if (pixels[rowOffset + x * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) return canvasRect;
      const scaleX = canvasRect.width / canvas.width;
      const scaleY = canvasRect.height / canvas.height;
      const projectedLeft = canvasRect.left + left * scaleX;
      const projectedTop = canvasRect.top + top * scaleY;
      const projectedRight = canvasRect.left + (right + 1) * scaleX;
      const projectedBottom = canvasRect.top + (bottom + 1) * scaleY;
      return {
        left: projectedLeft,
        right: projectedRight,
        width: projectedRight - projectedLeft,
        x: projectedLeft,
        top: projectedTop,
        bottom: projectedBottom,
        y: projectedTop,
        height: projectedBottom - projectedTop,
        toJSON: () => ({}),
      };
    } catch {
      return canvasRect;
    }
  }

  applyImageByKey(key: string, url: string): void {
    const spread = this.currentSpread();
    const canvas = this.readActiveCanvas();
    if (!spread || !canvas || this.pageKey(spread.pageIndex) !== key) return;
    const projections = [
      ...this.screenLayer.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]'),
    ];
    if (url === this.pageReference(spread.pageIndex)) {
      for (const projection of projections) projection.remove();
      return;
    }
    const image = projections[0] ?? this.document.createElement('img');
    for (const duplicate of projections) {
      if (duplicate !== image) duplicate.remove();
    }
    image.dataset.mtReadingProjection = '';
    image.dataset.mtReadingProjectionKey = key;
    image.alt = '';
    image.src = url;
    image.style.position = 'absolute';
    image.style.pointerEvents = 'none';
    image.style.zIndex = '2147483645';
    image.style.objectFit = 'contain';
    image.style.objectPosition = 'center center';
    if (image.parentElement !== this.screenLayer) this.screenLayer.appendChild(image);
    const layerRect = this.screenLayer.getBoundingClientRect();
    const projectionRect = this.readProjectionViewport(canvas);
    image.style.left = `${projectionRect.left - layerRect.left}px`;
    image.style.top = `${projectionRect.top - layerRect.top}px`;
    image.style.width = `${projectionRect.width}px`;
    image.style.height = `${projectionRect.height}px`;
  }

  private removeStaleProjections(): void {
    const spread = this.currentSpread();
    const currentKey = spread ? this.pageKey(spread.pageIndex) : null;
    for (const projection of this.screenLayer.querySelectorAll<HTMLImageElement>(
      '[data-mt-reading-projection]',
    )) {
      if (!currentKey || projection.dataset.mtReadingProjectionKey !== currentKey) {
        projection.remove();
      }
    }
  }

  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void {
    if (this.disposed) return () => undefined;
    this.signalListeners.add(onSignal);
    if (this.manifest || this.manifestError) queueMicrotask(() => {
      if (!this.disposed && this.signalListeners.has(onSignal)) {
        onSignal({ kind: 'structure-changed' });
      }
    });
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => onSignal({ kind: 'geometry-changed' }));
    resizeObserver?.observe(this.root);
    resizeObserver?.observe(this.screenLayer);
    for (const canvas of this.screenLayer.querySelectorAll('canvas')) resizeObserver?.observe(canvas);
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          if (records.every(mutationOnlyTouchesExtensionNodes)) return;
          this.removeStaleProjections();
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
      this.signalListeners.delete(onSignal);
      this.observerStops.delete(stop);
    };
    this.observerStops.add(stop);
    return stop;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of [...this.observerStops]) stop();
    this.signalListeners.clear();
    this.bottomBarAnchor?.remove();
    this.bottomBarAnchor = null;
    for (const projection of this.screenLayer.querySelectorAll('[data-mt-reading-projection]')) {
      projection.remove();
    }
  }
}

class ClipStudioReaderAdapter implements ReaderEngineAdapter {
  readonly engineId = 'clip-studio-reader';

  constructor(private readonly dependencies: ClipStudioReaderDependencies) {}

  detect(): ReaderEngineDetection | null {
    const root = this.dependencies.document.querySelector<HTMLElement>(rootSelector);
    if (!root || !hasClipStudioScripts(this.dependencies.document)) return null;
    const config = readDetectionConfig(root, this.dependencies);
    if (!config) return null;
    const canvases = config.screenLayer.querySelectorAll('canvas');
    if (
      canvases.length === 0
      || !this.dependencies.document.querySelector(currentCounterSelector)
      || !this.dependencies.document.querySelector(totalCounterSelector)
    ) {
      return null;
    }
    return {
      confidence: 'strong',
      root,
      sessionAnchor: config.screenLayer,
      contextKey: config.contextKey,
      evidence: [
        'CSR Web player script',
        `${rootSelector} ${screenLayerSelector} canvas`,
        `${currentCounterSelector} + ${totalCounterSelector}`,
        'observed HTTPS diazepam resource protocol',
      ],
    };
  }

  createSession(detection: ReaderEngineDetection): ReaderEngineSession {
    return this.createReaderSession(detection);
  }

  createReadingModeSession(detection: ReaderEngineDetection): ReaderEngineReadingModeSession {
    return this.createReaderSession(detection);
  }

  private createReaderSession(detection: ReaderEngineDetection): ClipStudioReaderSession {
    const config = readDetectionConfig(detection.root, this.dependencies);
    if (
      !config
      || detection.sessionAnchor !== config.screenLayer
      || detection.contextKey !== config.contextKey
    ) {
      throw new Error('Invalid CLIP STUDIO READER detection');
    }
    return new ClipStudioReaderSession(
      detection.root,
      config.screenLayer,
      this.dependencies.document,
      this.dependencies.window,
      config,
      this.dependencies,
    );
  }
}

export function createClipStudioReaderAdapter(
  dependencies: ClipStudioReaderDependencies = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
  },
): ReaderEngineAdapter {
  return new ClipStudioReaderAdapter(dependencies);
}
