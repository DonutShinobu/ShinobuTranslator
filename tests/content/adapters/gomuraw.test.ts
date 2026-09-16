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
    return { width: 800, height: 1200, top: 0, bottom: 1200, left: 0, right: 800 };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gomuraw adapter', () => {
  it('matches only GoMuRaw chapter reader pages', () => {
    expect(isGomurawChapterPage('gomuraw.onl', pathname)).toBe(true);
    expect(isGomurawChapterPage('www.gomuraw.onl', `${pathname}/`)).toBe(true);
    expect(isGomurawChapterPage('gomuraw.onl', '/manga/example-series')).toBe(false);
    expect(isGomurawChapterPage('example.com', pathname)).toBe(false);
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
    vi.stubGlobal('location', {
      hostname: 'gomuraw.onl',
      pathname,
      href: pageUrl,
    });
    vi.stubGlobal('window', {
      innerWidth: 1200,
      innerHeight: 900,
    });
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => images),
    });
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
});
