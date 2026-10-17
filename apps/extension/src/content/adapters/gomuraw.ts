import type {
  ImageTarget,
  ReadingPageDiscovery,
  ReadingPageReference,
  ReadingPageTarget,
  SiteAdapter,
} from '../core/types';

type GomurawImageCandidate = {
  currentSrc?: string;
  src: string;
  getAttribute(name: string): string | null;
};

const chapterPagePattern = /^\/manga\/[^/]+\/chapter-[^/]+\/?$/u;
const chapterImageSelector = '.read-viewer .page-chapter > img';
const maxChapterPages = 500;
const originalSourceAttr = 'data-mt-original-src';
const readingAnchorAttr = 'data-mt-gomuraw-reading-anchor';
const imageAnchorAttr = 'data-mt-gomuraw-image-anchor';

export function isGomurawChapterPage(hostname: string, pathname: string): boolean {
  return /^(?:www\.)?gomuraw\.(?:onl|wiki|link)$/u.test(hostname)
    && chapterPagePattern.test(pathname);
}

function toHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function readGomurawOriginalUrl(
  image: GomurawImageCandidate,
  baseUrl: string,
): string | null {
  const candidates = [
    image.getAttribute(originalSourceAttr),
    image.getAttribute('data-original'),
    image.getAttribute('data-cdn'),
    image.currentSrc,
    image.src,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    const url = toHttpUrl(value, baseUrl);
    if (url) return url;
  }
  return null;
}

export function collectGomurawPageTargets(
  images: readonly GomurawImageCandidate[],
  pathname: string,
  baseUrl: string,
): ReadingPageTarget[] {
  const pages: ReadingPageTarget[] = [];
  for (const [pageIndex, image] of images.entries()) {
    const originalUrl = readGomurawOriginalUrl(image, baseUrl);
    if (!originalUrl) continue;
    pages.push({
      key: `${pathname}::${pageIndex}`,
      originalUrl,
      pageIndex,
    });
  }
  return pages;
}

function chapterImages(): HTMLImageElement[] {
  if (!isGomurawChapterPage(location.hostname, location.pathname)) return [];
  return Array.from(document.querySelectorAll<HTMLImageElement>(chapterImageSelector));
}

function chapterPageEntries(): Array<{ image: HTMLImageElement; target: ReadingPageTarget }> {
  const images = chapterImages();
  return collectGomurawPageTargets(images, location.pathname, location.href).map((target) => {
    const image = images[target.pageIndex];
    if (!image.hasAttribute(originalSourceAttr)) {
      image.setAttribute(originalSourceAttr, target.originalUrl);
    }
    return { image, target };
  });
}

function isVisiblePage(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.top < window.innerHeight
    && rect.right > 0
    && rect.left < window.innerWidth;
}

function visiblePages(): ReadingPageReference[] {
  return chapterPageEntries()
    .filter((entry) => isVisiblePage(entry.image))
    .map((entry) => entry.target);
}

function applyImageByKey(key: string, url: string): void {
  const entry = chapterPageEntries().find((page) => page.target.key === key);
  if (entry && entry.image.src !== url) entry.image.src = url;
}

export function createGomurawAdapter(): SiteAdapter {
  let bottomBarAnchor: HTMLElement | null = null;

  return {
    match() {
      return isGomurawChapterPage(location.hostname, location.pathname);
    },

    findImages() {
      // GoMuRaw chapter pages use the shared reading-mode controls instead of
      // mounting one translation button on every image in the long strip.
      return [];
    },

    createUiAnchor(target: ImageTarget) {
      const wrapper = target.element.closest<HTMLElement>('.page-chapter')
        ?? target.element.parentElement
        ?? document.body;
      const existingAnchor = wrapper.querySelector<HTMLElement>(`[${imageAnchorAttr}]`);
      if (existingAnchor) return existingAnchor;

      if (window.getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';

      const anchor = document.createElement('div');
      anchor.setAttribute(imageAnchorAttr, '');
      anchor.dataset.theme = 'light';
      anchor.style.cssText = 'position:absolute; right:12px; top:12px; z-index:20;';
      wrapper.appendChild(anchor);
      return anchor;
    },

    applyImage(target, url) {
      target.element.src = url;
    },

    observe(onChange) {
      const observer = new MutationObserver((mutations) => {
        // Rendering the reading bar must not schedule another render.
        if (mutations.some((mutation) => mutation.type === 'childList'
          && !(mutation.target instanceof Element
            && mutation.target.closest(`[${readingAnchorAttr}], [${imageAnchorAttr}]`)))) onChange();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('popstate', onChange);
      window.addEventListener('scroll', onChange, { passive: true });
      window.addEventListener('resize', onChange);
      const onLoad = (event: Event): void => {
        if (event.target instanceof HTMLImageElement && event.target.matches(chapterImageSelector)) onChange();
      };
      document.addEventListener('load', onLoad, true);

      return () => {
        observer.disconnect();
        window.removeEventListener('popstate', onChange);
        window.removeEventListener('scroll', onChange);
        window.removeEventListener('resize', onChange);
        document.removeEventListener('load', onLoad, true);
        bottomBarAnchor?.remove();
        bottomBarAnchor = null;
      };
    },

    isReadingMode() {
      return isGomurawChapterPage(location.hostname, location.pathname);
    },

    getReadingContextKey() {
      if (!isGomurawChapterPage(location.hostname, location.pathname)) return null;
      return `${location.hostname}${location.pathname}`;
    },

    async discoverReadingPages(signal): Promise<ReadingPageDiscovery> {
      if (signal?.aborted) return { status: 'incomplete', reason: 'request-failed' };
      const images = chapterImages();
      if (images.length === 0) {
        return { status: 'incomplete', reason: 'metadata-unavailable' };
      }
      if (images.length > maxChapterPages) {
        return {
          status: 'incomplete',
          reason: 'page-limit-exceeded',
          pageCount: images.length,
          maxPages: maxChapterPages,
        };
      }
      const pages = chapterPageEntries().map((entry) => entry.target);
      if (pages.length !== images.length) return { status: 'incomplete', reason: 'invalid-response' };
      return { status: 'complete', pages };
    },

    getVisiblePages() {
      return visiblePages();
    },

    createBottomBarAnchor() {
      if (bottomBarAnchor?.isConnected) return bottomBarAnchor;
      const existingAnchor = document.querySelector<HTMLElement>(`[${readingAnchorAttr}]`);
      if (existingAnchor) {
        bottomBarAnchor = existingAnchor;
        return existingAnchor;
      }

      const anchor = document.createElement('div');
      anchor.setAttribute(readingAnchorAttr, '');
      anchor.dataset.theme = 'light';
      anchor.style.cssText = [
        'position:fixed',
        'right:max(16px, env(safe-area-inset-right))',
        'bottom:max(16px, env(safe-area-inset-bottom))',
        'z-index:2147483646',
        'display:flex',
        'flex-direction:column',
        'align-items:flex-end',
        'max-width:calc(100vw - 32px)',
      ].join(';');
      document.body.appendChild(anchor);
      bottomBarAnchor = anchor;
      return anchor;
    },

    applyImageByKey(key, url) {
      applyImageByKey(key, url);
    },
  };
}

export const gomurawAdapter = createGomurawAdapter();
