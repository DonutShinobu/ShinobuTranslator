import type { ImageTarget, SiteAdapter } from '../core/types';

type ImageCandidate = {
  id?: string;
  src: string;
  currentSrc?: string;
  naturalWidth: number;
  naturalHeight: number;
  clientWidth: number;
  clientHeight: number;
};

const anchorAttr = 'data-mt-ehentai-anchor';
const minMainImageArea = 200 * 200;

export function isEhentaiImagePage(hostname: string, pathname: string): boolean {
  return (hostname === 'e-hentai.org' || hostname === 'exhentai.org') && pathname.startsWith('/s/');
}

function imageSource(image: Pick<ImageCandidate, 'currentSrc' | 'src'>): string {
  return image.currentSrc || image.src;
}

function visibleArea(image: Pick<ImageCandidate, 'clientWidth' | 'clientHeight' | 'naturalWidth' | 'naturalHeight'>): number {
  const width = image.clientWidth || image.naturalWidth;
  const height = image.clientHeight || image.naturalHeight;
  return width * height;
}

export function pickEhentaiMainImage<T extends ImageCandidate>(images: T[]): T | null {
  const byId = images.find((image) => image.id === 'img' && imageSource(image));
  if (byId) {
    return byId;
  }

  let best: T | null = null;
  let bestArea = 0;
  for (const image of images) {
    if (!imageSource(image)) {
      continue;
    }
    const area = visibleArea(image);
    if (area < minMainImageArea || area <= bestArea) {
      continue;
    }
    best = image;
    bestArea = area;
  }
  return best;
}

export function normalizeEhentaiImageKey(pageUrl: string, imageUrl: string): string {
  return `${pageUrl}::${imageUrl}`;
}

function findMainImage(): HTMLImageElement | null {
  const images = Array.from(document.images);
  return pickEhentaiMainImage(images);
}

function getImageWrapper(image: HTMLImageElement): HTMLElement {
  const namedWrapper = image.closest<HTMLElement>('#i3, #i2, #i1');
  return namedWrapper ?? image.parentElement ?? document.body;
}

export const ehentaiAdapter: SiteAdapter = {
  match() {
    return isEhentaiImagePage(location.hostname, location.pathname);
  },

  findImages() {
    const image = findMainImage();
    const originalUrl = image ? imageSource(image) : '';
    if (!image || !originalUrl) {
      return [];
    }
    const key = normalizeEhentaiImageKey(location.href, originalUrl);
    return [{ element: image, key, originalUrl }];
  },

  createUiAnchor(target: ImageTarget) {
    const wrapper = getImageWrapper(target.element);
    const existingAnchor = wrapper.querySelector(`[${anchorAttr}]`);
    if (existingAnchor instanceof HTMLElement) {
      return existingAnchor;
    }

    const currentPosition = window.getComputedStyle(wrapper).position;
    if (currentPosition === 'static') {
      wrapper.style.position = 'relative';
    }

    const anchor = document.createElement('div');
    anchor.setAttribute(anchorAttr, '');
    anchor.dataset.theme = 'dark';
    anchor.style.cssText = 'position:absolute; right:12px; top:12px; z-index:20;';
    wrapper.appendChild(anchor);
    return anchor;
  },

  applyImage(target: ImageTarget, url: string) {
    target.element.src = url;
  },

  observe(onChange: () => void) {
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList')) {
        onChange();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  },
};
