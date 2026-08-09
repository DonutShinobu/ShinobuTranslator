import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBinbReaderEngineAdapter } from '../../../apps/extension/src/content/readerEngines/binb';
import type {
  BinbContentClient,
  BinbManifest,
} from '../../../apps/extension/src/content/readerEngines/binbContent';

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
    id: '',
    isConnected: true,
    dataset: {},
    style: {},
    parentElement: null,
    classList: { contains: () => false } as unknown as DOMTokenList,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => rect(0, 0, 100, 100),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: vi.fn(),
    remove: vi.fn(),
    contains: () => false,
    ...overrides,
  } as unknown as HTMLElement;
}

function pageSlot(pageNumber: number, slotRect: DOMRect, sourceWidth = 800) {
  const renderedImage = element({
    width: sourceWidth,
    naturalWidth: sourceWidth,
  } as Partial<HTMLImageElement>) as unknown as HTMLImageElement;
  const surface = element({
    getBoundingClientRect: () => slotRect,
    querySelectorAll: (selector: string) => selector === 'img'
      ? [renderedImage] as unknown as NodeListOf<HTMLImageElement>
      : [] as unknown as NodeListOf<HTMLElement>,
  });
  const projections: HTMLImageElement[] = [];
  const slot = element({
    id: `content-p${pageNumber}`,
    getAttribute: (name: string) => name === 'data-ptimg' ? `binb://slot-${pageNumber}` : null,
    getBoundingClientRect: () => slotRect,
    querySelector: (selector: string) => selector === '.pt-img' ? surface : null,
    querySelectorAll: (selector: string) => selector === '[data-mt-reading-projection]'
      ? projections as unknown as NodeListOf<HTMLImageElement>
      : [] as unknown as NodeListOf<HTMLElement>,
    appendChild: ((child: Node) => {
      const image = child as HTMLImageElement;
      Object.defineProperty(image, 'parentElement', { value: slot, configurable: true });
      image.remove = vi.fn(() => {
        const index = projections.indexOf(image);
        if (index >= 0) projections.splice(index, 1);
      });
      projections.push(image);
      return child;
    }) as unknown as HTMLElement['appendChild'],
  });
  Object.defineProperty(surface, 'parentElement', { value: slot, configurable: true });
  return { slot, surface, projections };
}

function manifest(pageCount = 3): BinbManifest {
  return {
    cid: 'book-1',
    serverType: 1,
    viewMode: 2,
    contentBaseUrl: 'https://cdn.example/books/book-1/',
    contentDate: '20260809',
    imageClass: 'multiquality',
    readerUrl: 'https://reader.example/viewer/?cid=book-1',
    scrambleTables: { stbl: [1], ttbl: [1], ptbl: ['x'], ctbl: ['y'] },
    pages: Array.from({ length: pageCount }, (_, pageIndex) => ({
      pageIndex,
      src: `pages/page-${pageIndex + 1}.jpg`,
      width: 800,
      height: 1200,
      scrambleSourceKey: 'primary',
      scrambleDestinationKey: 'secondary',
    })),
  };
}

function readerDom(slots: readonly HTMLElement[]) {
  const root = element({
    id: 'content',
    classList: { contains: (name: string) => name === 'pages' } as unknown as DOMTokenList,
    getAttribute: (name: string) => ({
      'data-ptbinb': '/bib-api/bibGetCntntInfo',
      'data-ptbinb-cid': 'book-1',
    })[name] ?? null,
    querySelector: (selector: string) => selector === ':scope > [data-ptimg] > .pt-img'
      ? slots[0]?.querySelector('.pt-img') ?? null
      : null,
    querySelectorAll: (selector: string) => selector === ':scope > [data-ptimg]'
      ? slots as unknown as NodeListOf<HTMLElement>
      : [] as unknown as NodeListOf<HTMLElement>,
  });
  const created: HTMLElement[] = [];
  const body = element({ appendChild: vi.fn() });
  const document = {
    body,
    fullscreenElement: null,
    documentElement: element(),
    querySelector: (selector: string) => selector === '#content[data-ptbinb]' ? root : null,
    createElement: (name: string) => {
      const value = element({ tagName: name.toUpperCase() } as Partial<HTMLElement>);
      created.push(value);
      return value;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Document;
  return { root, document, created };
}

function createAdapter(
  slots: readonly HTMLElement[],
  contentClient: BinbContentClient,
  overrides: Record<string, unknown> = {},
) {
  const dom = readerDom(slots);
  const adapter = createBinbReaderEngineAdapter({
    document: dom.document,
    window: {
      innerWidth: 1_000,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window,
    location: {
      href: 'https://reader.example/viewer/?cid=book-1',
      origin: 'https://reader.example',
      pathname: '/viewer/',
      search: '?cid=book-1',
    },
    createContentClient: vi.fn(() => contentClient),
    ...overrides,
  });
  return { adapter, ...dom };
}

describe('BinB reader engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires the Speed Reader root, same-origin content API, and a rendered pt-img slot', () => {
    const first = pageSlot(1, rect(100, 0, 500, 700));
    const client = { read: vi.fn(async () => manifest()) };
    const { adapter, root } = createAdapter([first.slot], client);

    expect(adapter.detect()).toEqual({
      confidence: 'strong',
      root,
      sessionAnchor: root,
      contextKey: 'binb:book-1:https://reader.example/viewer/',
      evidence: [
        '#content[data-ptbinb]',
        'same-origin HTTPS bibGetCntntInfo',
        ':scope > [data-ptimg] > .pt-img',
        'content-pN physical ordinal',
      ],
    });

    const crossOrigin = readerDom([first.slot]);
    crossOrigin.root.getAttribute = (name: string) => name === 'data-ptbinb'
      ? 'https://evil.example/info'
      : name === 'data-ptbinb-cid' ? 'book-1' : null;
    expect(createBinbReaderEngineAdapter({
      document: crossOrigin.document,
      window: globalThis.window,
      location: {
        href: 'https://reader.example/viewer/?cid=book-1',
        origin: 'https://reader.example',
        pathname: '/viewer/',
        search: '?cid=book-1',
      },
      createContentClient: () => client,
    }).detect()).toBeNull();
  });

  it('maps reverse DOM slots to context plus deduplicated physical ordinals', () => {
    const fifth = pageSlot(5, rect(-700, 0, 500, 700));
    const second = pageSlot(2, rect(500, 0, 450, 700));
    const first = pageSlot(1, rect(20, 0, 450, 700));
    const { adapter } = createAdapter(
      [fifth.slot, second.slot, first.slot],
      { read: vi.fn(async () => manifest(5)) },
    );
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    expect(session.readVisibleSpread()).toEqual({
      pages: [
        expect.objectContaining({
          identity: expect.objectContaining({ pageIndex: 0 }),
          slot: first.slot,
          source: { kind: 'viewport-region' },
        }),
        expect.objectContaining({
          identity: expect.objectContaining({ pageIndex: 1 }),
          slot: second.slot,
          source: { kind: 'viewport-region' },
        }),
      ],
    });
    expect(session.getVisiblePages().map((page) => page.pageIndex)).toEqual([0, 1]);
  });

  it('discovers all physical image pages and enforces the 200-page translate-all limit', async () => {
    const first = pageSlot(1, rect(0, 0, 500, 700));
    const complete = createAdapter(
      [first.slot],
      { read: vi.fn(async () => manifest(3)) },
    ).adapter;
    const completeSession = complete.createReadingModeSession!(complete.detect()!);
    await expect(completeSession.discoverReadingPages()).resolves.toEqual({
      status: 'complete',
      pages: [0, 1, 2].map((pageIndex) => ({
        key: `${completeSession.contextKey}:page:${pageIndex}`,
        originalUrl: `engine-source:${completeSession.contextKey}:page:${pageIndex}`,
        pageIndex,
      })),
    });

    const limited = createAdapter(
      [first.slot],
      { read: vi.fn(async () => manifest(201)) },
    ).adapter;
    const limitedSession = limited.createReadingModeSession!(limited.detect()!);
    await expect(limitedSession.discoverReadingPages()).resolves.toEqual({
      status: 'incomplete',
      reason: 'page-limit-exceeded',
      pageCount: 201,
      maxPages: 200,
    });
  });

  it('follows the rendered quality, prepares an unseen page, and projects translated results', async () => {
    const first = pageSlot(1, rect(100, 50, 400, 600), 800);
    const raw = new Blob(['raw'], { type: 'image/jpeg' });
    const downloadImage = vi.fn(async (_source: unknown) => ({
      blob: raw,
      file: new File([raw], 'raw.jpg', { type: raw.type }),
    }));
    const restored = new File(['restored'], 'restored.png', { type: 'image/png' });
    const restoreImage = vi.fn(async () => restored);
    const { adapter } = createAdapter(
      [first.slot],
      { read: vi.fn(async () => manifest(3)) },
      { downloadImage, restoreImage },
    );
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    await expect(session.prepareReadingPage!({
      key: `${session.contextKey}:page:2`,
      originalUrl: `engine-source:${session.contextKey}:page:2`,
      pageIndex: 2,
    }, new AbortController().signal)).resolves.toEqual({
      source: { kind: 'prepared-file', file: restored },
    });
    expect(downloadImage.mock.calls[0][0]).toMatchObject({
      url: expect.stringContaining('/pages/page-3.jpg/M_H.jpg'),
      allowedBaseUrl: 'https://cdn.example/books/book-1/',
    });

    const key = `${session.contextKey}:page:0`;
    session.applyImageByKey(key, 'blob:translated');
    expect(first.projections).toHaveLength(1);
    expect(first.projections[0]).toMatchObject({ src: 'blob:translated' });
    expect(first.projections[0].style).toMatchObject({
      left: '0px',
      top: '0px',
      width: '400px',
      height: '600px',
    });
    session.applyImageByKey(key, `engine-source:${key}`);
    expect(first.projections).toHaveLength(0);
  });

  it('follows the viewer resource quality when high and low images have equal dimensions', async () => {
    const first = pageSlot(1, rect(0, 0, 400, 600), 800);
    const raw = new Blob(['raw'], { type: 'image/jpeg' });
    const downloadImage = vi.fn(async (_source: unknown) => ({
      blob: raw,
      file: new File([raw], 'raw.jpg', { type: raw.type }),
    }));
    const readerWindow = {
      innerWidth: 1_000,
      innerHeight: 800,
      performance: {
        getEntriesByType: () => [{
          name: 'https://cdn.example/books/book-1/pages/page-1.jpg/M_L.jpg?dmytime=1',
        }],
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const { adapter } = createAdapter(
      [first.slot],
      { read: vi.fn(async () => manifest()) },
      {
        window: readerWindow,
        downloadImage,
        restoreImage: vi.fn(async () => new File(['restored'], 'restored.png')),
      },
    );
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    await session.prepareReadingPage!({
      key: `${session.contextKey}:page:0`,
      originalUrl: `engine-source:${session.contextKey}:page:0`,
      pageIndex: 0,
    }, new AbortController().signal);

    expect(downloadImage.mock.calls[0][0]).toMatchObject({
      url: expect.stringContaining('/M_L.jpg'),
    });
  });

  it('emits structure and geometry signals and disconnects observers', () => {
    const mutationInstances: Array<{ callback: MutationCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
    const resizeDisconnect = vi.fn();
    const resizeObserve = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(public callback: MutationCallback) {
        mutationInstances.push(this);
      }
    });
    vi.stubGlobal('ResizeObserver', class {
      disconnect = resizeDisconnect;
      observe = resizeObserve;
      unobserve = vi.fn();
    });
    const first = pageSlot(1, rect(0, 0, 500, 700));
    const slots = [first.slot];
    const { adapter } = createAdapter(
      slots,
      { read: vi.fn(async () => manifest()) },
    );
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const onSignal = vi.fn();

    const stop = session.observe(onSignal);
    const second = pageSlot(2, rect(500, 0, 400, 700));
    slots.push(second.slot);
    mutationInstances[0].callback([{
      type: 'childList',
      target: first.slot,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord], mutationInstances[0] as unknown as MutationObserver);
    expect(onSignal).toHaveBeenCalledWith({ kind: 'structure-changed' });
    expect(resizeObserve).toHaveBeenCalledWith(second.slot);
    expect(resizeObserve).toHaveBeenCalledWith(second.surface);
    stop();
    expect(mutationInstances[0].disconnect).toHaveBeenCalledOnce();
    expect(resizeDisconnect).toHaveBeenCalledOnce();
  });
});
