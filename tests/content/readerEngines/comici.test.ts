import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComiciReaderEngineAdapter } from '../../../apps/extension/src/content/readerEngines/comici';
import {
  createComiciTileMoves,
  parseComiciContentsInfo,
  restoreComiciPageImage,
} from '../../../apps/extension/src/content/readerEngines/comiciManifest';

function element(overrides: Partial<HTMLElement> = {}): HTMLElement {
  return {
    isConnected: true,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    ...overrides,
  } as unknown as HTMLElement;
}

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

function pageSlot(
  classes: readonly string[],
  canvasRect: DOMRect,
): { slot: HTMLElement; canvas: HTMLCanvasElement; anchor: HTMLElement } {
  const canvas = element({
    width: 848,
    height: 1200,
    getBoundingClientRect: () => canvasRect,
  } as Partial<HTMLCanvasElement>) as unknown as HTMLCanvasElement;
  const anchor = element();
  const slot = element({
    classList: { contains: (name: string) => classes.includes(name) } as DOMTokenList,
    querySelector: (selector: string) => {
      if (selector === '.-cv-page-canvas > canvas') return canvas;
      if (selector === '.-cv-page-content') return anchor;
      return null;
    },
  });
  return { slot, canvas, anchor };
}

describe('Comici reader engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires every structural fingerprint and records the evidence', () => {
    const page = element();
    const pages = element({ querySelector: () => page });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
    });
    const selectors = new Map<string, Element>([
      ['#comici-viewer[data-comici-viewer-id].-cv', root],
      ['#xCVPages.-cv-pages', pages],
    ]);
    const document = {
      querySelector: (selector: string) => selectors.get(selector) ?? null,
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });

    expect(adapter.detect()).toEqual({
      confidence: 'strong',
      root,
      sessionAnchor: pages,
      evidence: [
        '#comici-viewer[data-comici-viewer-id].-cv',
        '#xCVPages.-cv-pages',
        '#xCVPages > .-cv-page',
      ],
    });

    selectors.delete('#xCVPages.-cv-pages');
    expect(adapter.detect()).toBeNull();
  });

  it('enumerates visible rendered body pages by logical body-page ordinal', () => {
    const bodyPage = pageSlot(['-cv-page', 'mode-rendered'], rect(10, 5, 40, 80));
    const promotionalPage = pageSlot(
      ['-cv-page', 'mode-rendered', 'mode-pr'],
      rect(50, 5, 40, 80),
    );
    const secondBodyPage = pageSlot(['-cv-page', 'mode-rendered'], rect(50, 5, 40, 80));
    const offscreenPage = pageSlot(['-cv-page', 'mode-rendered'], rect(120, 5, 40, 80));
    const slots = [bodyPage, promotionalPage, secondBodyPage, offscreenPage];
    const pages = element({
      querySelector: () => bodyPage.slot,
      querySelectorAll: () => slots.map((item) => item.slot) as unknown as NodeListOf<Element>,
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
      getBoundingClientRect: () => rect(0, 0, 100, 100),
    });
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });
    const detection = adapter.detect();
    expect(detection).not.toBeNull();

    const session = adapter.createReadingModeSession(detection!);

    expect(session.contextKey).toBe(
      'comici:viewer-42:https://reader.example/episodes/one',
    );
    expect(session.readVisibleSpread()).toEqual({
      pages: [
        expect.objectContaining({
          identity: {
            engineId: 'comici',
            contextKey: session.contextKey,
            pageIndex: 0,
          },
          slot: bodyPage.slot,
          source: { kind: 'canvas', element: bodyPage.canvas },
          projectionAnchor: bodyPage.anchor,
        }),
        expect.objectContaining({
          identity: {
            engineId: 'comici',
            contextKey: session.contextKey,
            pageIndex: 1,
          },
          slot: secondBodyPage.slot,
          source: { kind: 'canvas', element: secondBodyPage.canvas },
          projectionAnchor: secondBodyPage.anchor,
        }),
      ],
    });
  });

  it('projects engine changes as generic signals and ignores extension nodes', () => {
    let mutationCallback: MutationCallback | undefined;
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });

    const transitionListeners: EventListener[] = [];
    const page = element();
    const pages = element({
      querySelector: () => page,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        transitionListeners.push(listener as EventListener);
      },
      removeEventListener: vi.fn(),
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
    });
    const documentListeners = new Map<string, EventListener>();
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
      addEventListener: (type: string, listener: EventListener) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });
    const session = adapter.createReadingModeSession(adapter.detect()!);
    const signals: string[] = [];
    const stop = session.observe((signal) => signals.push(signal.kind));

    mutationCallback?.([{
      type: 'childList',
      target: pages,
      addedNodes: [{
        nodeType: 1,
        getAttribute: (name: string) => name === 'data-mt-projection' ? '' : null,
        querySelector: () => null,
      } as unknown as Node] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord], {} as MutationObserver);
    mutationCallback?.([{
      type: 'attributes',
      attributeName: 'class',
      target: page,
    } as unknown as MutationRecord], {} as MutationObserver);
    resizeCallback?.([], {} as ResizeObserver);
    transitionListeners[0]?.(new Event('transitionend'));
    documentListeners.get('fullscreenchange')?.(new Event('fullscreenchange'));

    expect(signals).toEqual([
      'structure-changed',
      'geometry-changed',
      'render-settled',
      'geometry-changed',
    ]);

    stop();
    session.dispose();
  });

  it('rebinds resize observation when lazy-mounted visible canvases change', () => {
    let mutationCallback: MutationCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    });
    vi.stubGlobal('ResizeObserver', class {
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
    });

    const first = pageSlot(['-cv-page', 'mode-rendered'], rect(0, 0, 100, 100));
    const second = pageSlot(['-cv-page', 'mode-rendered'], rect(0, 0, 100, 100));
    let visible = [first];
    const pages = element({
      querySelector: () => first.slot,
      querySelectorAll: () => visible.map((item) => item.slot) as unknown as NodeListOf<Element>,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
      getBoundingClientRect: () => rect(0, 0, 100, 100),
    });
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const session = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    }).createReadingModeSession({ confidence: 'strong', root, evidence: ['fake'] });

    session.observe(() => undefined);
    expect(observe).toHaveBeenCalledWith(first.slot);
    expect(observe).toHaveBeenCalledWith(first.canvas);

    visible = [second];
    mutationCallback?.([{
      type: 'childList',
      target: pages,
      addedNodes: [second.slot] as unknown as NodeList,
      removedNodes: [first.slot] as unknown as NodeList,
    } as unknown as MutationRecord], {} as MutationObserver);

    expect(unobserve).toHaveBeenCalledWith(first.slot);
    expect(unobserve).toHaveBeenCalledWith(first.canvas);
    expect(observe).toHaveBeenCalledWith(second.slot);
    expect(observe).toHaveBeenCalledWith(second.canvas);
  });

  it('discovers the complete chapter and prepares an unseen page without turning to it', async () => {
    const bodyPage = pageSlot(['-cv-page', 'mode-rendered'], rect(0, 0, 100, 100));
    const pages = element({
      querySelector: () => bodyPage.slot,
      querySelectorAll: () => [bodyPage.slot] as unknown as NodeListOf<Element>,
    });
    const attributes = new Map([
      ['data-comici-viewer-id', 'viewer-42'],
      ['data-api-domain', '/api'],
    ]);
    const root = element({
      getAttribute: (name) => attributes.get(name) ?? null,
      getBoundingClientRect: () => rect(0, 0, 100, 100),
    });
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
    } as unknown as Document;
    const descriptor = (sort: number) => ({
      sort,
      width: 850,
      height: 1200,
      expiresOn: Date.now() + 60_000,
      scramble: JSON.stringify([13, 0, 7, 10, 1, 8, 12, 5, 15, 14, 2, 9, 11, 4, 6, 3]),
      imageUrl: `https://viewer.reader.example/book/viewer-42/page-${sort}.jpg?Expires=1`,
    });
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const full = url.searchParams.get('page-to') === '2';
      return new Response(JSON.stringify({
        totalPages: 3,
        result: full ? [descriptor(0), descriptor(1), descriptor(2)] : [descriptor(0)],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const raw = new Blob(['scrambled'], { type: 'image/jpeg' });
    const downloadImage = vi.fn(async () => ({
      blob: raw,
      file: new File([raw], 'raw.jpg', { type: raw.type }),
    }));
    const restored = new File(['restored'], 'page-2.png', { type: 'image/png' });
    const restoreImage = vi.fn(async () => restored);
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
      fetch: fetch as typeof globalThis.fetch,
      downloadImage,
      restoreImage,
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    const discovery = await session.discoverReadingPages?.();
    expect(discovery).toEqual({
      status: 'complete',
      pages: [0, 1, 2].map((pageIndex) => ({
        key: `${session.contextKey}:page:${pageIndex}`,
        originalUrl: `engine-source:${session.contextKey}:page:${pageIndex}`,
        pageIndex,
      })),
    });
    const page = discovery?.status === 'complete' ? discovery.pages[1] : null;
    expect(page).not.toBeNull();
    const request = await session.prepareReadingPage!(page!, new AbortController().signal);

    expect(request).toEqual({ source: { kind: 'prepared-file', file: restored } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toContain('page-from=0');
    expect(String(fetch.mock.calls[1][0])).toContain('page-to=2');
    expect(downloadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'remote-image',
        url: expect.stringContaining('/book/viewer-42/page-1.jpg'),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(restoreImage).toHaveBeenCalledWith(
      raw,
      expect.objectContaining({ pageIndex: 1 }),
      expect.any(AbortSignal),
    );
  });

  it('rejects malformed manifests and exposes the official 4x4 tile mapping', () => {
    const context = {
      viewerId: 'viewer-42',
      pageOrigin: 'https://reader.example',
      requireComplete: true,
    };
    const base = {
      width: 850,
      height: 1200,
      expiresOn: Date.now() + 60_000,
      scramble: JSON.stringify([13, 0, 7, 10, 1, 8, 12, 5, 15, 14, 2, 9, 11, 4, 6, 3]),
      imageUrl: 'https://viewer.reader.example/book/viewer-42/page.jpg?Expires=1',
    };

    expect(parseComiciContentsInfo({
      totalPages: 2,
      result: [{ ...base, sort: 0 }, { ...base, sort: 0 }],
    }, context)).toBeNull();
    expect(createComiciTileMoves(JSON.parse(base.scramble)).slice(0, 2)).toEqual([
      {
        sourceColumn: 3,
        sourceRow: 1,
        destinationColumn: 0,
        destinationRow: 0,
      },
      {
        sourceColumn: 0,
        sourceRow: 0,
        destinationColumn: 0,
        destinationRow: 1,
      },
    ]);
  });

  it('restores pixels with Comici column-major destination traversal', async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 40,
      height: 40,
      close,
    })));
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(new Blob(['restored'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const document = {
      createElement: (name: string) => name === 'canvas' ? canvas : null,
    } as unknown as Document;
    const scramble = [13, 0, 7, 10, 1, 8, 12, 5, 15, 14, 2, 9, 11, 4, 6, 3];

    await restoreComiciPageImage(
      new Blob(['scrambled'], { type: 'image/jpeg' }),
      {
        pageIndex: 0,
        imageUrl: 'https://viewer.reader.example/book/viewer-42/page.jpg',
        scramble,
        width: 40,
        height: 40,
        expiresOn: Date.now() + 60_000,
      },
      new AbortController().signal,
      document,
    );

    expect(drawImage.mock.calls[0].slice(1)).toEqual([30, 10, 10, 10, 0, 0, 10, 10]);
    expect(drawImage.mock.calls[1].slice(1)).toEqual([0, 0, 10, 10, 0, 10, 10, 10]);
    expect(drawImage).toHaveBeenCalledTimes(16);
    expect(close).toHaveBeenCalledOnce();
  });
});
