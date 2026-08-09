import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
  ReaderEngineReadingModeSession,
  ReaderEngineSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../core/continuous/contracts';
import type {
  ReadingLogicalPagePlan,
  ReadingLogicalPageResultSlice,
  ReadingLogicalPageTarget,
  ReadingPageReference,
  ReadingPageTarget,
} from '../core/types';
import {
  createRuntimeImageDownloader,
  type DownloadImageForTranslation,
} from '../core/translation/imageTranslationExecution';
import { sendRuntimeMessage } from '../../shared/messages';
import {
  readLocalDetectorSignature,
  runLocalDetectionProbe,
  type ReadLocalDetectorSignature,
  type RunLocalDetectionProbe,
} from '../core/translation/localPipelineClient';
import {
  acquireGigaViewerPageFile,
  createGigaViewerContextKey,
  gigaViewerTranslateAllPageLimit,
  readGigaViewerManifest,
  restoreGigaViewerPageImage,
  type GigaViewerManifest,
  type GigaViewerManifestSource,
} from './gigaViewerManifest';
import {
  planGigaViewerTtbLogicalPages,
  type GigaViewerTtbLogicalPagePlan,
} from './gigaViewerTtbPagination';
import {
  composeGigaViewerTtbFiles,
  splitGigaViewerTtbBlob,
} from './gigaViewerTtbImages';

const rootSelector = 'section.js-viewer';
const pagesSelector = '.js-viewer-content';
const directPageSelector = ':scope > .js-page-area';
const episodeJsonSelector = '#episode-json[data-value]';

function intersectionArea(left: DOMRect, right: DOMRect): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function isExtensionNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const names = typeof element.getAttributeNames === 'function'
    ? element.getAttributeNames()
    : ['data-mt-reading-projection', 'data-mt-reader-engine-ui']
        .filter((name) => element.getAttribute?.(name) !== null);
  return names.some((name) => name.startsWith('data-mt-'));
}

function mutationOnlyTouchesExtensionNodes(record: MutationRecord): boolean {
  if (isExtensionNode(record.target)) return true;
  if (record.type !== 'childList') return false;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.length > 0 && changed.every(isExtensionNode);
}

function isNonBodySlot(slot: HTMLElement): boolean {
  return slot.classList.contains('js-back-matter-area')
    || Boolean(slot.querySelector('.page-dummy'))
    || Boolean(slot.querySelector('.js-link-page'))
    || Boolean(slot.querySelector('.js-page-ad'))
    || Boolean(slot.querySelector('.js-back-matter'));
}

function readMainSlots(
  pages: HTMLElement,
  manifest: GigaViewerManifest,
): Array<{ slot: HTMLElement; pageIndex: number }> {
  const slots = [...pages.querySelectorAll<HTMLElement>(directPageSelector)]
    .filter((slot) => !isNonBodySlot(slot));
  if (slots.length !== manifest.pages.length) return [];
  return slots.map((slot, pageIndex) => ({ slot, pageIndex }));
}

export type GigaViewerReaderEngineDependencies = {
  document: Document;
  location: Pick<Location, 'origin' | 'pathname'>;
  downloadImage?: DownloadImageForTranslation;
  restoreImage?: typeof restoreGigaViewerPageImage;
  probeDetection?: RunLocalDetectionProbe;
  readDetectorSignature?: ReadLocalDetectorSignature;
  composeVerticalFiles?: typeof composeGigaViewerTtbFiles;
  splitVerticalBlob?: typeof splitGigaViewerTtbBlob;
};

type GigaViewerTtbPaginationEntry = {
  target: ReadingLogicalPageTarget;
  pageIndices: readonly number[];
  precomputedDetection?: Awaited<ReturnType<RunLocalDetectionProbe>>['detection'];
};

type GigaViewerTtbPaginationCache = {
  key: string;
  plan: ReadingLogicalPagePlan;
  diagnostics: GigaViewerTtbLogicalPagePlan['boundaries'];
  detectorSignature: string;
  entries: ReadonlyMap<string, GigaViewerTtbPaginationEntry>;
};

class GigaViewerReaderEngineSession implements ReaderEngineReadingModeSession {
  readonly engineId = 'giga-viewer';
  readonly contextKey: string;
  private readonly observers = new Set<() => void>();
  private readonly manifestSource: GigaViewerManifestSource;
  private readonly downloadImage: DownloadImageForTranslation;
  private readonly restoreImage: typeof restoreGigaViewerPageImage;
  private readonly probeDetection: RunLocalDetectionProbe;
  private readonly readDetectorSignature: ReadLocalDetectorSignature;
  private readonly composeVerticalFiles: typeof composeGigaViewerTtbFiles;
  private readonly splitVerticalBlob: typeof splitGigaViewerTtbBlob;
  private ttbPaginationCache: GigaViewerTtbPaginationCache | null = null;
  private bottomBarAnchor: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly pages: HTMLElement,
    private readonly document: Document,
    private readonly location: Pick<Location, 'origin' | 'pathname'>,
    contextKey: string,
    dependencies: Pick<
      GigaViewerReaderEngineDependencies,
      | 'downloadImage'
      | 'restoreImage'
      | 'probeDetection'
      | 'readDetectorSignature'
      | 'composeVerticalFiles'
      | 'splitVerticalBlob'
    >,
  ) {
    this.contextKey = contextKey;
    this.manifestSource = { read: () => readGigaViewerManifest(this.document) };
    this.downloadImage = dependencies.downloadImage
      ?? createRuntimeImageDownloader(sendRuntimeMessage);
    this.restoreImage = dependencies.restoreImage ?? restoreGigaViewerPageImage;
    this.probeDetection = dependencies.probeDetection ?? runLocalDetectionProbe;
    this.readDetectorSignature = dependencies.readDetectorSignature ?? readLocalDetectorSignature;
    this.composeVerticalFiles = dependencies.composeVerticalFiles ?? composeGigaViewerTtbFiles;
    this.splitVerticalBlob = dependencies.splitVerticalBlob ?? splitGigaViewerTtbBlob;
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

  private readCurrentManifest(): GigaViewerManifest | null {
    const manifest = this.manifestSource.read();
    if (!manifest) return null;
    return createGigaViewerContextKey(manifest, this.location) === this.contextKey
      ? manifest
      : null;
  }

  private readBodySlots(): Array<{ slot: HTMLElement; pageIndex: number }> {
    const manifest = this.readCurrentManifest();
    if (!manifest || !this.pages.isConnected) return [];
    return readMainSlots(this.pages, manifest);
  }

  readVisibleSpread(): ReaderVisibleSpread {
    if (!this.root.isConnected || !this.pages.isConnected) return { pages: [] };
    const rootRect = this.root.getBoundingClientRect();
    const surfaces = this.readBodySlots()
      .map(({ slot, pageIndex }) => {
        const canvas = slot.querySelector<HTMLCanvasElement>('canvas.js-page-image');
        if (!canvas?.isConnected) return null;
        const canvasRect = canvas.getBoundingClientRect();
        if (
          canvasRect.width <= 0
          || canvasRect.height <= 0
          || intersectionArea(canvasRect, rootRect) <= 0
        ) {
          return null;
        }
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
          projectionAnchor: slot,
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

  async discoverReadingPages() {
    const manifest = this.readCurrentManifest();
    if (!manifest) {
      return { status: 'incomplete' as const, reason: 'metadata-unavailable' as const };
    }
    if (!manifest.supportedDirection) {
      return {
        status: 'incomplete' as const,
        reason: 'unsupported-format' as const,
        detail: `阅读方向 ${manifest.readingDirection}`,
      };
    }
    if (manifest.imageMode === 'unsupported') {
      return {
        status: 'incomplete' as const,
        reason: 'unsupported-format' as const,
        detail: '未知图片处理模式',
      };
    }
    if (manifest.pages.length > gigaViewerTranslateAllPageLimit) {
      return {
        status: 'incomplete' as const,
        reason: 'page-limit-exceeded' as const,
        pageCount: manifest.pages.length,
        maxPages: gigaViewerTranslateAllPageLimit,
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
  }

  async planReadingLogicalPages(
    pages: readonly ReadingPageTarget[],
    signal: AbortSignal,
  ): Promise<ReadingLogicalPagePlan> {
    const manifest = this.readCurrentManifest();
    if (!manifest) throw new Error('GigaViewer reading context changed');
    if (
      pages.length !== manifest.pages.length
      || pages.some((page, index) => page.pageIndex !== index || page.key !== this.pageKey(index))
    ) {
      throw new Error('GigaViewer 阅读页列表与当前章节不一致');
    }
    if (manifest.readingDirection !== 'ttb' || pages.length < 2) {
      return {
        pages: pages.map((page) => ({ ...page, members: [page] })),
      };
    }

    const requestedDetectorSignature = this.readDetectorSignature();
    if (this.ttbPaginationCache?.detectorSignature === requestedDetectorSignature) {
      return this.ttbPaginationCache.plan;
    }
    this.ttbPaginationCache = null;

    const probeResults: Awaited<ReturnType<RunLocalDetectionProbe>>[] = [];
    for (const page of manifest.pages) {
      if (signal.aborted) throw signal.reason;
      const file = await acquireGigaViewerPageFile(
        page.pageIndex,
        this.contextKey,
        this.manifestSource,
        this.location,
        this.downloadImage,
        this.restoreImage,
        signal,
      );
      const probe = await this.probeDetection(file, { signal });
      if (probe.detection.width !== page.width || probe.detection.height !== page.height) {
        throw new Error(`GigaViewer TTB 第 ${page.pageIndex + 1} 个切片的预检测尺寸不一致`);
      }
      probeResults.push(probe);
    }

    const detectorSignatures = new Set(probeResults.map(({ detectorSignature }) => detectorSignature));
    if (detectorSignatures.size !== 1) {
      throw new Error('GigaViewer TTB 预检测期间 detector 签名发生变化');
    }
    const probeDetectorSignature = probeResults[0].detectorSignature;
    const cacheKey = JSON.stringify([
      this.contextKey,
      'ttb-edge-mask-v2',
      requestedDetectorSignature,
      probeDetectorSignature,
    ]);

    const pagination: GigaViewerTtbLogicalPagePlan = planGigaViewerTtbLogicalPages(
      manifest.pages.map((_, pageIndex) => ({
        pageIndex,
        width: probeResults[pageIndex].detection.width,
        height: probeResults[pageIndex].detection.height,
        topTouches: probeResults[pageIndex].topTouches,
        bottomTouches: probeResults[pageIndex].bottomTouches,
        topStrength: probeResults[pageIndex].topStrength,
        bottomStrength: probeResults[pageIndex].bottomStrength,
      })),
    );
    const sourceByIndex = new Map(pages.map((page) => [page.pageIndex, page]));
    const entries = new Map<string, GigaViewerTtbPaginationEntry>();
    const logicalPages = pagination.pages.map((logicalPage): ReadingLogicalPageTarget => {
      const members = logicalPage.pageIndices.map((pageIndex) => {
        const page = sourceByIndex.get(pageIndex);
        if (!page) throw new Error(`GigaViewer TTB 第 ${pageIndex + 1} 个切片不存在`);
        return page;
      });
      const first = members[0];
      const last = members[members.length - 1];
      const key = `${this.contextKey}:logical:${first.pageIndex}-${last.pageIndex}`;
      const target: ReadingLogicalPageTarget = {
        key,
        originalUrl: `engine-source:${key}`,
        pageIndex: first.pageIndex,
        members,
      };
      entries.set(key, {
        target,
        pageIndices: logicalPage.pageIndices,
        precomputedDetection: members.length === 1
          ? probeResults[first.pageIndex].detection
          : undefined,
      });
      return target;
    });
    const plan: ReadingLogicalPagePlan = { pages: logicalPages };
    this.ttbPaginationCache = {
      key: cacheKey,
      plan,
      diagnostics: pagination.boundaries,
      detectorSignature: requestedDetectorSignature,
      entries,
    };
    return plan;
  }

  async prepareReadingPage(page: ReadingPageReference, signal: AbortSignal) {
    const paginationEntry = this.ttbPaginationCache?.entries.get(page.key);
    if (paginationEntry) {
      const files: File[] = [];
      for (const pageIndex of paginationEntry.pageIndices) {
        files.push(await acquireGigaViewerPageFile(
          pageIndex,
          this.contextKey,
          this.manifestSource,
          this.location,
          this.downloadImage,
          this.restoreImage,
          signal,
        ));
      }
      if (files.length === 1) {
        return {
          source: { kind: 'prepared-file' as const, file: files[0] },
          precomputedDetection: paginationEntry.precomputedDetection,
        };
      }
      const file = await this.composeVerticalFiles(files, signal, this.document);
      return { source: { kind: 'prepared-file' as const, file } };
    }
    if (!Number.isInteger(page.pageIndex) || Number(page.pageIndex) < 0) {
      throw new Error('GigaViewer reading page has no logical page index');
    }
    const file = await acquireGigaViewerPageFile(
      Number(page.pageIndex),
      this.contextKey,
      this.manifestSource,
      this.location,
      this.downloadImage,
      this.restoreImage,
      signal,
    );
    return { source: { kind: 'prepared-file' as const, file } };
  }

  async splitReadingLogicalPageResult(
    page: ReadingLogicalPageTarget,
    image: Blob,
    debug: Blob | undefined,
    signal: AbortSignal,
  ): Promise<readonly ReadingLogicalPageResultSlice[]> {
    const entry = this.ttbPaginationCache?.entries.get(page.key);
    if (!entry || entry.target.members.length === 1) {
      const target = entry?.target.members[0] ?? page.members[0];
      return [{ page: target, image, ...(debug ? { debug } : {}) }];
    }
    const manifest = this.readCurrentManifest();
    if (!manifest) throw new Error('GigaViewer reading context changed');
    const heights = entry.pageIndices.map((pageIndex) => manifest.pages[pageIndex].height);
    const images = await this.splitVerticalBlob(image, heights, signal, this.document);
    const debugImages = debug
      ? await this.splitVerticalBlob(debug, heights, signal, this.document)
      : undefined;
    return entry.target.members.map((member, index) => ({
      page: member,
      image: images[index],
      ...(debugImages ? { debug: debugImages[index] } : {}),
    }));
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
    anchor.dataset.mtReaderEngineUi = 'giga-viewer';
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
    const projections = [
      ...target.slot.querySelectorAll<HTMLImageElement>('[data-mt-reading-projection]'),
    ];
    if (url === this.pageReference(target.pageIndex)) {
      for (const projection of projections) projection.remove();
      return;
    }
    const canvas = target.slot.querySelector<HTMLCanvasElement>('canvas.js-page-image');
    if (!canvas?.isConnected) return;
    const image = projections[0] ?? this.document.createElement('img');
    for (const duplicate of projections.slice(1)) duplicate.remove();
    image.dataset.mtReadingProjection = '';
    image.alt = '';
    image.src = url;
    image.style.position = 'absolute';
    image.style.pointerEvents = 'none';
    image.style.zIndex = '2';
    image.style.objectFit = 'fill';
    if (image.parentElement !== target.slot) target.slot.appendChild(image);
    const slotRect = target.slot.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    image.style.left = `${canvasRect.left - slotRect.left}px`;
    image.style.top = `${canvasRect.top - slotRect.top}px`;
    image.style.width = `${canvasRect.width}px`;
    image.style.height = `${canvasRect.height}px`;
  }

  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void {
    if (this.disposed) return () => undefined;

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => onSignal({ kind: 'geometry-changed' }));
    const resizeTargets = new Set<Element>();
    const syncResizeTargets = (): void => {
      const current = new Set<Element>([this.root, this.pages]);
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
          onSignal({ kind: 'structure-changed' });
        });
    mutationObserver?.observe(this.pages, {
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
    const onScroll = (): void => onSignal({ kind: 'navigation-state-changed' });
    const onFullscreenChange = (): void => onSignal({ kind: 'geometry-changed' });
    const onVisibilityChange = (): void => onSignal({ kind: 'navigation-state-changed' });
    this.pages.addEventListener('transitionend', onTransitionEnd);
    this.pages.addEventListener('scroll', onScroll, { passive: true });
    this.document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    this.document.addEventListener('fullscreenchange', onFullscreenChange);
    this.document.addEventListener('visibilitychange', onVisibilityChange);

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      this.pages.removeEventListener('transitionend', onTransitionEnd);
      this.pages.removeEventListener('scroll', onScroll);
      this.document.removeEventListener('scroll', onScroll, true);
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
    this.ttbPaginationCache = null;
    for (const projection of this.root.querySelectorAll('[data-mt-reading-projection]')) {
      projection.remove();
    }
  }
}

class GigaViewerReaderEngineAdapter implements ReaderEngineAdapter {
  readonly engineId = 'giga-viewer';

  constructor(private readonly dependencies: GigaViewerReaderEngineDependencies) {}

  detect(): ReaderEngineDetection | null {
    const manifest = readGigaViewerManifest(this.dependencies.document);
    const root = this.dependencies.document.querySelector<HTMLElement>(rootSelector);
    const pages = root?.querySelector<HTMLElement>(pagesSelector)
      ?? this.dependencies.document.querySelector<HTMLElement>(pagesSelector);
    if (
      !manifest
      || !root
      || !pages
      || !pages.querySelector(directPageSelector)
      || readMainSlots(pages, manifest).length !== manifest.pages.length
    ) {
      return null;
    }
    const contextKey = createGigaViewerContextKey(manifest, this.dependencies.location);
    return {
      confidence: 'strong',
      root,
      sessionAnchor: pages,
      contextKey,
      evidence: [
        episodeJsonSelector,
        rootSelector,
        `${pagesSelector} > .js-page-area`,
        'readableProduct.pageStructure.pages',
      ],
    };
  }

  createSession(detection: ReaderEngineDetection): ReaderEngineSession {
    return this.createReaderSession(detection);
  }

  createReadingModeSession(detection: ReaderEngineDetection): ReaderEngineReadingModeSession {
    return this.createReaderSession(detection);
  }

  private createReaderSession(detection: ReaderEngineDetection): GigaViewerReaderEngineSession {
    const pages = detection.sessionAnchor;
    if (!pages || !detection.contextKey) {
      throw new Error('Invalid GigaViewer detection');
    }
    return new GigaViewerReaderEngineSession(
      detection.root,
      pages as HTMLElement,
      this.dependencies.document,
      this.dependencies.location,
      detection.contextKey,
      this.dependencies,
    );
  }
}

export function createGigaViewerReaderEngineAdapter(
  dependencies: GigaViewerReaderEngineDependencies = {
    document: globalThis.document,
    location: globalThis.location,
  },
): ReaderEngineAdapter {
  return new GigaViewerReaderEngineAdapter(dependencies);
}
