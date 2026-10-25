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
const projectedSources = new WeakMap<HTMLImageElement, { originalUrl: string; appliedUrl: string }>();

export function isEhentaiImagePage(hostname: string, pathname: string): boolean {
  return (hostname === 'e-hentai.org' || hostname === 'exhentai.org') && pathname.startsWith('/s/');
}

function imageSource(image: Pick<ImageCandidate, 'currentSrc' | 'src'>): string {
  // currentSrc can retain the previous blob while the next page loads.
  return image.src || image.currentSrc || '';
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
    if (!this.match()) return [];
    const image = findMainImage();
    const projection = image ? projectedSources.get(image) : undefined;
    let originalUrl = image ? imageSource(image) : '';
    if (image && projection) {
      originalUrl = image.src === projection.appliedUrl ? projection.originalUrl : image.src;
      if (image.src !== projection.appliedUrl) projectedSources.delete(image);
    }
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
    if (target.element.src === url) return;
    target.element.src = url;
    projectedSources.set(target.element, { originalUrl: target.originalUrl, appliedUrl: target.element.src });
  },

  observe(onChange: () => void) {
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList' || (
        mutation.target instanceof HTMLImageElement
        && (mutation.attributeName !== 'src'
          || mutation.target.src !== projectedSources.get(mutation.target)?.appliedUrl)
      ))) {
        onChange();
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
    });
    const onLoad = (event: Event): void => {
      if (event.target instanceof HTMLImageElement
        && event.target.src !== projectedSources.get(event.target)?.appliedUrl) onChange();
    };
    document.addEventListener('load', onLoad, true);

    return () => {
      observer.disconnect();
      document.removeEventListener('load', onLoad, true);
    };
  },
};
