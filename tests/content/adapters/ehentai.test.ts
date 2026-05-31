import { describe, expect, it } from 'vitest';
import {
  isEhentaiImagePage,
  normalizeEhentaiImageKey,
  pickEhentaiMainImage,
} from '../../../src/content/adapters/ehentai';

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
