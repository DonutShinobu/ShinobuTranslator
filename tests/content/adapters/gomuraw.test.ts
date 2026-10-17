import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectGomurawPageTargets,
  createGomurawAdapter,
  isGomurawChapterPage,
  readGomurawOriginalUrl,
} from '../../../apps/extension/src/content/adapters/gomuraw';

const pathname = '/manga/example-series/chapter-33';
const pageUrl = `https://gomuraw.onl${pathname}`;

class FakeImage {
  currentSrc = '';
  src: string;
  rect = { width: 800, height: 1200, top: 0, bottom: 1200, left: 0, right: 800 };
  private readonly attributes = new Map<string, string>();

  constructor(src: string, original = src) {
    this.src = src;
    this.attributes.set('src', src);
    this.attributes.set('data-original', original);
    this.attributes.set('data-cdn', original);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  matches(selector: string): boolean {
    return selector === '.read-viewer .page-chapter > img';
  }
}

function stubChapter(images: FakeImage[]): void {
  vi.stubGlobal('location', { hostname: 'gomuraw.onl', pathname, href: pageUrl });
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 900 });
  vi.stubGlobal('document', { querySelectorAll: vi.fn(() => images) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gomuraw adapter', () => {
  it('matches only GoMuRaw chapter reader pages', () => {
    expect(isGomurawChapterPage('gomuraw.onl', pathname)).toBe(true);
    expect(isGomurawChapterPage('www.gomuraw.onl', `${pathname}/`)).toBe(true);
    expect(isGomurawChapterPage('gomuraw.wiki', pathname)).toBe(true);
    expect(isGomurawChapterPage('www.gomuraw.wiki', `${pathname}/`)).toBe(true);
    expect(isGomurawChapterPage('gomuraw.link', pathname)).toBe(true);
    expect(isGomurawChapterPage('www.gomuraw.link', `${pathname}/`)).toBe(true);
    expect(isGomurawChapterPage('gomuraw.onl', '/manga/example-series')).toBe(false);
    expect(isGomurawChapterPage('example.com', pathname)).toBe(false);
    expect(isGomurawChapterPage('gomuraw.link.example.com', pathname)).toBe(false);
    expect(isGomurawChapterPage('other.gomuraw.link', pathname)).toBe(false);
  });

  it('keeps the authoritative data-original URL after the displayed image becomes a blob', () => {
    const image = new FakeImage('blob:translated', 'https://iphotomg.com/series/chapter_33/page_0.jpg');

    expect(readGomurawOriginalUrl(image, pageUrl))
      .toBe('https://iphotomg.com/series/chapter_33/page_0.jpg');
  });

  it('discovers every chapter image in DOM order with stable page keys', () => {
    const pages = collectGomurawPageTargets([
      new FakeImage('https://iphotomg.com/series/chapter_33/page_0.jpg'),
      new FakeImage('https://iphotomg.com/series/chapter_33/page_1.jpg'),
    ], pathname, pageUrl);

    expect(pages).toEqual([
      {
        key: `${pathname}::0`,
        originalUrl: 'https://iphotomg.com/series/chapter_33/page_0.jpg',
        pageIndex: 0,
      },
      {
        key: `${pathname}::1`,
        originalUrl: 'https://iphotomg.com/series/chapter_33/page_1.jpg',
        pageIndex: 1,
      },
    ]);
  });

  it('exposes complete chapter discovery and replaces an image without losing its source', async () => {
    const images = [
      new FakeImage('https://iphotomg.com/series/chapter_33/page_0.jpg'),
      new FakeImage('https://iphotomg.com/series/chapter_33/page_1.jpg'),
    ];
    stubChapter(images);
    const adapter = createGomurawAdapter();

    const discovery = await adapter.discoverReadingPages?.();
    expect(discovery).toMatchObject({ status: 'complete' });
    if (discovery?.status !== 'complete') throw new Error('Expected complete discovery');
    expect(discovery.pages).toHaveLength(2);

    adapter.applyImageByKey?.(`${pathname}::1`, 'blob:translated-page-1');
    expect(images[1].src).toBe('blob:translated-page-1');
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({
      status: 'complete',
      pages: [
        expect.any(Object),
        expect.objectContaining({
          originalUrl: 'https://iphotomg.com/series/chapter_33/page_1.jpg',
        }),
      ],
    });
  });

  it('resolves relative originals and skips empty or non-HTTP sources without shifting page keys', () => {
    const invalid = new FakeImage('data:image/png;base64,AAAA', 'javascript:alert(1)');
    invalid.currentSrc = 'blob:temporary';
    expect(readGomurawOriginalUrl(new FakeImage(' ', '\t'), pageUrl)).toBeNull();
    expect(collectGomurawPageTargets([
      invalid,
      new FakeImage('/chapter/page-2.jpg'),
    ], pathname, pageUrl)).toEqual([{
      key: `${pathname}::1`,
      originalUrl: 'https://gomuraw.onl/chapter/page-2.jpg',
      pageIndex: 1,
    }]);
  });

  it('fails closed when any chapter page has no usable source', async () => {
    stubChapter([
      new FakeImage('https://iphotomg.com/1.jpg'),
      new FakeImage('blob:loading', ''),
    ]);
    await expect(createGomurawAdapter().discoverReadingPages?.())
      .resolves.toEqual({ status: 'incomplete', reason: 'invalid-response' });
  });

  it('rejects an empty chapter, an aborted discovery and chapters beyond 500 pages', async () => {
    stubChapter([]);
    const adapter = createGomurawAdapter();
    await expect(adapter.discoverReadingPages?.())
      .resolves.toEqual({ status: 'incomplete', reason: 'metadata-unavailable' });
    await expect(adapter.discoverReadingPages?.(AbortSignal.abort()))
      .resolves.toEqual({ status: 'incomplete', reason: 'request-failed' });

    stubChapter(Array.from({ length: 501 }, (_, index) => new FakeImage(`https://iphotomg.com/${index}.jpg`)));
    await expect(adapter.discoverReadingPages?.()).resolves.toEqual({
      status: 'incomplete', reason: 'page-limit-exceeded', pageCount: 501, maxPages: 500,
    });
    stubChapter(Array.from({ length: 500 }, (_, index) => new FakeImage(`https://iphotomg.com/${index}.jpg`)));
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });
  });

  it('includes only visible pages and refuses late projection after chapter navigation', () => {
    const images = [0, 1, 2].map((index) => new FakeImage(`https://iphotomg.com/${index}.jpg`));
    images[1].rect = { ...images[1].rect, top: 1200, bottom: 2400 };
    images[2].rect = { ...images[2].rect, width: 0 };
    stubChapter(images);
    const adapter = createGomurawAdapter();
    expect(adapter.findImages()).toEqual([]);
    expect(adapter.getVisiblePages?.().map((page) => page.pageIndex)).toEqual([0]);
    expect(adapter.getReadingContextKey?.()).toBe(`gomuraw.onl${pathname}`);

    vi.stubGlobal('location', { hostname: 'gomuraw.onl', pathname: '/manga/another/chapter-1', href: 'https://gomuraw.onl/manga/another/chapter-1' });
    adapter.applyImageByKey?.(`${pathname}::0`, 'blob:stale-result');
    expect(images[0].src).toBe('https://iphotomg.com/0.jpg');
    vi.stubGlobal('location', { hostname: 'gomuraw.onl', pathname: '/', href: 'https://gomuraw.onl/' });
    expect(adapter.isReadingMode?.()).toBe(false);
    expect(adapter.getReadingContextKey?.()).toBeNull();
    expect(adapter.getVisiblePages?.()).toEqual([]);
  });

  it('observes chapter changes without scheduling itself on reading-bar rendering', () => {
    class FakeElement {
      constructor(private readonly isAnchor = false) {}
      closest() { return this.isAnchor ? this : null; }
    }
    let mutations!: MutationCallback;
    const disconnect = vi.fn(), observe = vi.fn();
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLImageElement', FakeImage);
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { mutations = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const addEventListener = vi.fn(), removeEventListener = vi.fn();
    const addDocumentListener = vi.fn(), removeDocumentListener = vi.fn();
    vi.stubGlobal('window', { addEventListener, removeEventListener });
    vi.stubGlobal('document', {
      body: new FakeElement(), addEventListener: addDocumentListener, removeEventListener: removeDocumentListener,
    });
    const onChange = vi.fn();
    const dispose = createGomurawAdapter().observe(onChange);

    mutations([{ type: 'childList', target: new FakeElement(true) } as unknown as MutationRecord], {} as MutationObserver);
    expect(onChange).not.toHaveBeenCalled();
    mutations([{ type: 'childList', target: new FakeElement() } as unknown as MutationRecord], {} as MutationObserver);
    expect(onChange).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledWith('popstate', onChange);
    expect(addEventListener).toHaveBeenCalledWith('scroll', onChange, { passive: true });
    expect(addEventListener).toHaveBeenCalledWith('resize', onChange);
    for (const type of ['scroll', 'resize']) {
      const listener = addEventListener.mock.calls.find(([eventType]) => eventType === type)?.[1] as () => void;
      listener();
    }
    const onLoad = addDocumentListener.mock.calls[0][1] as (event: Event) => void;
    onLoad({ target: new FakeImage('https://iphotomg.com/1.jpg') } as unknown as Event);
    onLoad({ target: new FakeElement() } as unknown as Event);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(observe).toHaveBeenCalledWith(document.body, { childList: true, subtree: true });
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('popstate', onChange);
    expect(removeEventListener).toHaveBeenCalledWith('scroll', onChange);
    expect(removeEventListener).toHaveBeenCalledWith('resize', onChange);
    expect(removeDocumentListener).toHaveBeenCalledWith('load', onLoad, true);
  });
});
