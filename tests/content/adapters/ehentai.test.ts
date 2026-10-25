import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ehentaiAdapter,
  isEhentaiImagePage,
  normalizeEhentaiImageKey,
  pickEhentaiMainImage,
} from '../../../apps/extension/src/content/adapters/ehentai';

afterEach(() => vi.unstubAllGlobals());

describe('ehentai adapter helpers', () => {
  it('matches image viewer pages on e-hentai and exhentai only', () => {
    expect(isEhentaiImagePage('e-hentai.org', '/s/be754cde63/3833082-4')).toBe(true);
    expect(isEhentaiImagePage('exhentai.org', '/s/be754cde63/3833082-4')).toBe(true);
    expect(isEhentaiImagePage('e-hentai.org', '/g/3833082/example')).toBe(false);
    expect(isEhentaiImagePage('example.com', '/s/be754cde63/3833082-4')).toBe(false);
  });

  it('prefers the #img viewer image over navigation icons', () => {
    const main = {
      id: 'img',
      src: 'https://example.test/main.webp',
      currentSrc: '',
      naturalWidth: 1280,
      naturalHeight: 1808,
      clientWidth: 1280,
      clientHeight: 1808,
    };

    expect(pickEhentaiMainImage([
      {
        id: '',
        src: 'https://ehgt.org/g/f.png',
        currentSrc: '',
        naturalWidth: 30,
        naturalHeight: 30,
        clientWidth: 34,
        clientHeight: 30,
      },
      main,
    ])).toBe(main);
  });

  it('falls back to the largest visible image and builds stable keys', () => {
    const main = {
      id: '',
      src: 'https://hath.network/003.webp',
      currentSrc: '',
      naturalWidth: 1280,
      naturalHeight: 1808,
      clientWidth: 1280,
      clientHeight: 1808,
    };

    expect(pickEhentaiMainImage([
      {
        id: '',
        src: 'https://ehgt.org/g/n.png',
        currentSrc: '',
        naturalWidth: 30,
        naturalHeight: 30,
        clientWidth: 34,
        clientHeight: 30,
      },
      main,
    ])).toBe(main);
    expect(normalizeEhentaiImageKey('https://e-hentai.org/s/be754cde63/3833082-4', main.src))
      .toBe('https://e-hentai.org/s/be754cde63/3833082-4::https://hath.network/003.webp');
  });
});

describe('ehentai adapter image lifecycle', () => {
  it('keeps the original key while projecting a translation and detects a reused image source', () => {
    const pageUrl = 'https://e-hentai.org/s/example/123-1';
    const firstUrl = 'https://hath.network/first.webp';
    const image = { id: 'img', src: firstUrl, currentSrc: firstUrl };
    vi.stubGlobal('location', { hostname: 'e-hentai.org', pathname: '/s/example/123-1', href: pageUrl });
    vi.stubGlobal('document', { images: [image] });
    const first = ehentaiAdapter.findImages()[0];

    ehentaiAdapter.applyImage(first, 'blob:translated');
    expect(ehentaiAdapter.findImages()[0]).toEqual(first);
    image.currentSrc = 'blob:translated';
    expect(ehentaiAdapter.findImages()[0]).toEqual(first);

    image.src = 'https://hath.network/second.webp';
    expect(ehentaiAdapter.findImages()[0]).toMatchObject({
      key: `${pageUrl}::https://hath.network/second.webp`,
      originalUrl: 'https://hath.network/second.webp',
    });
    expect(ehentaiAdapter.findImages()[0]).toMatchObject({
      key: `${pageUrl}::https://hath.network/second.webp`,
      originalUrl: 'https://hath.network/second.webp',
    });
  });

  it('observes source replacement and loading without responding to its own source projection', () => {
    class Image {
      src = 'https://hath.network/first.webp';
    }
    let mutations!: MutationCallback;
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('HTMLImageElement', Image);
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { mutations = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const addEventListener = vi.fn(), removeEventListener = vi.fn();
    const body = {};
    vi.stubGlobal('document', { body, addEventListener, removeEventListener });
    const onChange = vi.fn();
    const dispose = ehentaiAdapter.observe(onChange);
    const image = new Image() as HTMLImageElement;
    ehentaiAdapter.applyImage({ element: image, key: 'first', originalUrl: image.src }, 'blob:translated');
    const sourceMutation = { type: 'attributes', attributeName: 'src', target: image } as unknown as MutationRecord;
    mutations([sourceMutation], {} as MutationObserver);
    const onLoad = addEventListener.mock.calls[0][1] as (event: Event) => void;
    onLoad({ target: image } as unknown as Event);
    expect(onChange).not.toHaveBeenCalled();

    image.src = 'https://hath.network/second.webp';
    mutations([sourceMutation], {} as MutationObserver);
    onLoad({ target: image } as unknown as Event);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(body, expect.objectContaining({ attributeFilter: ['src', 'srcset'] }));
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('load', onLoad, true);
  });
});
