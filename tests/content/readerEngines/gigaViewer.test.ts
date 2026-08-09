import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGigaViewerReaderEngineAdapter } from '../../../apps/extension/src/content/readerEngines/gigaViewer';
import {
  createGigaViewerBakuTileMoves,
  parseGigaViewerManifest,
  restoreGigaViewerPageImage,
  type GigaViewerPageDescriptor,
} from '../../../apps/extension/src/content/readerEngines/gigaViewerManifest';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function element(overrides: Partial<HTMLElement> = {}): HTMLElement {
  return {
    isConnected: true,
    dataset: {},
    style: {},
    classList: { contains: () => false } as unknown as DOMTokenList,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => rect(0, 0, 100, 100),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as unknown as HTMLElement;
}

function slot(
  kind: 'main' | 'dummy' | 'link' | 'other' | 'backMatter',
  canvasRect = rect(0, 0, 100, 100),
): { slot: HTMLElement; canvas?: HTMLCanvasElement } {
  const canvas = kind === 'main'
    ? element({
        width: 840,
        height: 1200,
        getBoundingClientRect: () => canvasRect,
      } as Partial<HTMLCanvasElement>) as unknown as HTMLCanvasElement
    : undefined;
  const markers: Partial<Record<string, HTMLElement>> = {
    '.page-dummy': kind === 'dummy' ? element() : undefined,
    '.js-link-page': kind === 'link' ? element() : undefined,
    '.js-page-ad': kind === 'other' ? element() : undefined,
    '.js-back-matter': kind === 'backMatter' ? element() : undefined,
  };
  const value = element({
    classList: {
      contains: (name: string) => kind === 'backMatter' && name === 'js-back-matter-area',
    } as DOMTokenList,
    querySelector: (selector: string) => {
      if (selector === 'canvas.js-page-image') return canvas ?? null;
      return markers[selector] ?? null;
    },
  });
  return { slot: value, canvas };
}

function manifestValue(options: {
  direction?: string;
  mode?: unknown;
  pages?: Array<Record<string, unknown>>;
  productId?: string;
  digest?: string;
} = {}) {
  return {
    readableProduct: {
      id: options.productId ?? 'episode-1',
      typeName: 'episode',
      permalink: 'https://reader.example/episode/episode-1',
      imageUrisDigest: options.digest ?? 'digest-1',
      pageStructure: {
        readingDirection: options.direction ?? 'rtl',
        choJuGiga: options.mode ?? 'baku',
        pages: options.pages ?? [
          {
            type: 'main',
            src: 'https://cdn-img.reader.example/public/page/1',
            width: 840,
            height: 1200,
          },
        ],
      },
    },
  };
}

function readerDocument(
  value: unknown,
  root: HTMLElement,
  pages: HTMLElement,
): Document {
  const episodeJson = element({
    getAttribute: (name) => name === 'data-value' ? JSON.stringify(value) : null,
  });
  return {
    body: element(),
    fullscreenElement: null,
    querySelector: (selector: string) => {
      if (selector === '#episode-json[data-value]' || selector === '#episode-json') return episodeJson;
      if (selector === 'section.js-viewer') return root;
      if (selector === '.js-viewer-content') return pages;
      return null;
    },
    createElement: (name: string) => element({ tagName: name.toUpperCase() } as Partial<HTMLElement>),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Document;
}

function readerDom(value: unknown, slots: readonly HTMLElement[]) {
  const pages = element({
    querySelector: (selector: string) => selector === ':scope > .js-page-area'
      ? slots[0] ?? null
      : null,
    querySelectorAll: (selector: string) => selector === ':scope > .js-page-area'
      ? slots as unknown as NodeListOf<HTMLElement>
      : [] as unknown as NodeListOf<HTMLElement>,
  });
  const root = element({
    querySelector: (selector: string) => selector === '.js-viewer-content' ? pages : null,
    getBoundingClientRect: () => rect(0, 0, 100, 100),
  });
  return { root, pages, document: readerDocument(value, root, pages) };
}

describe('GigaViewer reader engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires the embedded manifest and live viewer DOM as a strong fingerprint', () => {
    const body = slot('main').slot;
    const value = manifestValue();
    const { root, pages, document } = readerDom(value, [body]);
    const adapter = createGigaViewerReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
    });

    expect(adapter.detect()).toEqual({
      confidence: 'strong',
      root,
      sessionAnchor: pages,
      contextKey: 'giga-viewer:episode:episode-1:digest-1:https://reader.example/episode/episode-1',
      evidence: [
        '#episode-json[data-value]',
        'section.js-viewer',
        '.js-viewer-content > .js-page-area',
        'readableProduct.pageStructure.pages',
      ],
    });

    const noManifest = readerDocument({}, root, pages);
    expect(createGigaViewerReaderEngineAdapter({
      document: noManifest,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
    }).detect()).toBeNull();
  });

  it('filters special pages and keeps continuous logical body-page indexes', () => {
    const parsed = parseGigaViewerManifest(manifestValue({
      direction: 'ltr',
      mode: 'usagi',
      pages: [
        { type: 'other' },
        {
          type: 'main',
          src: 'https://cdn-img.reader.example/public/page/first',
          width: 800,
          height: 1200,
        },
        { type: 'link' },
        {
          type: 'main',
          src: 'https://cdn-img.reader.example/public/page/second.gif',
          width: 1600,
          height: 1200,
          align: 'center',
          isGif: true,
        },
        { type: 'backMatter' },
      ],
    }));

    expect(parsed).toMatchObject({
      readingDirection: 'ltr',
      supportedDirection: true,
      imageMode: 'raw',
      manifestPageCount: 5,
    });
    expect(parsed?.pages).toEqual([
      expect.objectContaining({ pageIndex: 0, manifestIndex: 1, isGif: false }),
      expect.objectContaining({ pageIndex: 1, manifestIndex: 3, isGif: true }),
    ]);
  });

  it('maps synthetic and special DOM slots without shifting visible page identity', () => {
    const value = manifestValue({
      direction: 'ttb',
      pages: [
        { type: 'other' },
        {
          type: 'main',
          src: 'https://cdn-img.reader.example/public/page/first',
          width: 800,
          height: 1200,
        },
        { type: 'link' },
        {
          type: 'main',
          src: 'https://cdn-img.reader.example/public/page/second',
          width: 800,
          height: 1200,
        },
        { type: 'backMatter' },
      ],
    });
    const dummy = slot('dummy');
    const other = slot('other');
    const first = slot('main', rect(0, 0, 100, 100));
    const link = slot('link');
    const second = slot('main', rect(90, 0, 40, 100));
    const backMatter = slot('backMatter');
    const { document } = readerDom(value, [
      dummy.slot,
      other.slot,
      first.slot,
      link.slot,
      second.slot,
      backMatter.slot,
    ]);
    const adapter = createGigaViewerReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
    });
    const detection = adapter.detect();
    expect(detection).not.toBeNull();
    const session = adapter.createSession(detection!);

    expect(session.readVisibleSpread()).toEqual({
      pages: [
        expect.objectContaining({
          identity: expect.objectContaining({ pageIndex: 0 }),
          slot: first.slot,
          source: { kind: 'canvas', element: first.canvas },
        }),
        expect.objectContaining({
          identity: expect.objectContaining({ pageIndex: 1 }),
          slot: second.slot,
          source: { kind: 'canvas', element: second.canvas },
        }),
      ],
    });
  });

  it('discovers the complete chapter and prepares an unseen baku page', async () => {
    const value = manifestValue({
      pages: Array.from({ length: 3 }, (_, index) => ({
        type: 'main',
        src: `https://cdn-img.reader.example/public/page/${index}`,
        width: 840,
        height: 1200,
      })),
    });
    const slots = Array.from({ length: 3 }, () => slot('main').slot);
    const { document } = readerDom(value, slots);
    const raw = new Blob(['scrambled'], { type: 'image/jpeg' });
    const downloadImage = vi.fn(async () => ({
      blob: raw,
      file: new File([raw], 'raw.jpg', { type: raw.type }),
    }));
    const restored = new File(['restored'], 'restored.png', { type: 'image/png' });
    const restoreImage = vi.fn(async () => restored);
    const adapter = createGigaViewerReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
      downloadImage,
      restoreImage,
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    const discovery = await session.discoverReadingPages();
    expect(discovery).toEqual({
      status: 'complete',
      pages: [0, 1, 2].map((pageIndex) => ({
        key: `${session.contextKey}:page:${pageIndex}`,
        originalUrl: `engine-source:${session.contextKey}:page:${pageIndex}`,
        pageIndex,
      })),
    });
    const page = discovery.status === 'complete' ? discovery.pages[1] : null;
    const prepared = await session.prepareReadingPage!(page!, new AbortController().signal);

    expect(prepared).toEqual({ source: { kind: 'prepared-file', file: restored } });
    expect(downloadImage).toHaveBeenCalledWith(
      {
        kind: 'remote-image',
        url: 'https://cdn-img.reader.example/public/page/1',
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(restoreImage).toHaveBeenCalledWith(
      raw,
      expect.objectContaining({ pageIndex: 1, imageMode: 'baku' }),
      expect.any(AbortSignal),
    );
  });

  it('freezes one TTB logical-page plan and reuses singleton detections', async () => {
    const value = manifestValue({
      direction: 'ttb',
      pages: Array.from({ length: 5 }, (_, index) => ({
        type: 'main',
        src: `https://cdn-img.reader.example/public/page/${index}`,
        width: 720,
        height: 703,
      })),
    });
    const { document } = readerDom(
      value,
      Array.from({ length: 5 }, () => slot('main').slot),
    );
    const downloadImage = vi.fn(async () => {
      const raw = new Blob(['raw'], { type: 'image/jpeg' });
      return { blob: raw, file: new File([raw], 'raw.jpg', { type: raw.type }) };
    });
    const restoreImage = vi.fn(async (
      _raw: Blob,
      page: GigaViewerPageDescriptor,
    ) => new File([String(page.pageIndex)], `page-${page.pageIndex}.png`, {
      type: 'image/png',
    }));
    const contacts = [
      { topTouches: false, bottomTouches: true },
      { topTouches: true, bottomTouches: true },
      { topTouches: false, bottomTouches: true },
      { topTouches: true, bottomTouches: false },
      { topTouches: false, bottomTouches: false },
    ];
    const detections = contacts.map((contact, pageIndex) => ({
      detection: {
        width: 720,
        height: 703,
        packedMask: new Blob([new Uint8Array(Math.ceil((720 * 703) / 8))]),
        regions: [{
          id: `region-${pageIndex}`,
          box: { x: 1, y: 1, width: 2, height: 2 },
          sourceText: '',
          translatedText: '',
        }],
      },
      detectorSignature: 'detector-v1',
      ...contact,
    }));
    let currentDetectorSignature = 'package-v1';
    const probeDetection = vi.fn(async (file: File) => {
      const pageIndex = Number(file.name.match(/page-(\d+)/)?.[1]);
      return detections[pageIndex];
    });
    const combined = new File(['combined'], 'combined.png', { type: 'image/png' });
    const composeVerticalFiles = vi.fn(async () => combined);
    const adapter = createGigaViewerReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
      downloadImage,
      restoreImage,
      probeDetection,
      readDetectorSignature: () => currentDetectorSignature,
      composeVerticalFiles,
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const discovery = await session.discoverReadingPages();
    if (discovery.status !== 'complete') throw new Error('expected complete discovery');

    const firstPlan = await session.planReadingLogicalPages!(
      discovery.pages,
      new AbortController().signal,
    );
    const secondPlan = await session.planReadingLogicalPages!(
      discovery.pages,
      new AbortController().signal,
    );

    expect(firstPlan).toBe(secondPlan);
    expect(probeDetection).toHaveBeenCalledTimes(5);
    expect(firstPlan.pages.map((page) => page.members.map((member) => member.pageIndex))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    currentDetectorSignature = 'package-v2';
    const refreshedPlan = await session.planReadingLogicalPages!(
      discovery.pages,
      new AbortController().signal,
    );
    expect(refreshedPlan).not.toBe(firstPlan);
    expect(probeDetection).toHaveBeenCalledTimes(10);

    const mergedRequest = await session.prepareReadingPage!(
      firstPlan.pages[0],
      new AbortController().signal,
    );
    expect(mergedRequest).toEqual({
      source: { kind: 'prepared-file', file: combined },
    });
    expect(composeVerticalFiles).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(File), expect.any(File)]),
      expect.any(AbortSignal),
      document,
    );

    const singletonRequest = await session.prepareReadingPage!(
      firstPlan.pages[2],
      new AbortController().signal,
    );
    expect(singletonRequest).toEqual({
      source: { kind: 'prepared-file', file: expect.any(File) },
      precomputedDetection: detections[4].detection,
    });
  });

  it('reports unsupported variants and the explicit translate-all page limit', async () => {
    const tooManyPages = Array.from({ length: 201 }, (_, index) => ({
      type: 'main',
      src: `https://cdn-img.reader.example/public/page/${index}`,
      width: 800,
      height: 1200,
    }));
    const limitedValue = manifestValue({ pages: tooManyPages });
    const limitedDom = readerDom(
      limitedValue,
      Array.from({ length: 201 }, () => slot('main').slot),
    );
    const limitedAdapter = createGigaViewerReaderEngineAdapter({
      document: limitedDom.document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
    });
    const limitedSession = limitedAdapter.createReadingModeSession!(limitedAdapter.detect()!);
    await expect(limitedSession.discoverReadingPages()).resolves.toEqual({
      status: 'incomplete',
      reason: 'page-limit-exceeded',
      pageCount: 201,
      maxPages: 200,
    });

    const unsupportedValue = manifestValue({ direction: 'diagonal', mode: 'unknown-mode' });
    const unsupportedDom = readerDom(unsupportedValue, [slot('main').slot]);
    const unsupportedAdapter = createGigaViewerReaderEngineAdapter({
      document: unsupportedDom.document,
      location: { origin: 'https://reader.example', pathname: '/episode/episode-1' },
    });
    const unsupportedSession = unsupportedAdapter.createReadingModeSession!(
      unsupportedAdapter.detect()!,
    );
    await expect(unsupportedSession.discoverReadingPages()).resolves.toEqual({
      status: 'incomplete',
      reason: 'unsupported-format',
      detail: '阅读方向 diagonal',
    });
  });

  it('rejects unsafe manifests before they become a strong engine match', () => {
    const insecure = manifestValue({
      pages: [{
        type: 'main',
        src: 'http://cdn-img.reader.example/public/page/1',
        width: 800,
        height: 1200,
      }],
    });
    expect(parseGigaViewerManifest(insecure)).toBeNull();

    const oversized = manifestValue({
      pages: [{
        type: 'main',
        src: 'https://cdn-img.reader.example/public/page/1',
        width: 20_000,
        height: 20_000,
      }],
    });
    expect(parseGigaViewerManifest(oversized)).toBeNull();
  });

  it('restores baku pixels with the official fixed 4x4 transpose', async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 42, height: 41, close })));
    const context = { drawImage, imageSmoothingEnabled: true };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(['restored'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const document = {
      createElement: (name: string) => name === 'canvas' ? canvas : null,
    } as unknown as Document;
    const page: GigaViewerPageDescriptor = {
      pageIndex: 0,
      manifestIndex: 0,
      imageUrl: 'https://cdn-img.reader.example/public/page/1',
      width: 42,
      height: 41,
      imageMode: 'baku',
      isGif: false,
    };

    expect(createGigaViewerBakuTileMoves().slice(0, 2)).toEqual([
      { sourceColumn: 0, sourceRow: 0, destinationColumn: 0, destinationRow: 0 },
      { sourceColumn: 1, sourceRow: 0, destinationColumn: 0, destinationRow: 1 },
    ]);
    await restoreGigaViewerPageImage(
      new Blob(['scrambled'], { type: 'image/jpeg' }),
      page,
      new AbortController().signal,
      document,
    );

    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 42, 41, 0, 0, 42, 41]);
    expect(drawImage.mock.calls[1].slice(1)).toEqual([0, 0, 8, 8, 0, 0, 8, 8]);
    expect(drawImage.mock.calls[2].slice(1)).toEqual([8, 0, 8, 8, 0, 8, 8, 8]);
    expect(drawImage).toHaveBeenCalledTimes(17);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});
