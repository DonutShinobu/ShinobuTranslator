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
const maxChapterPages = 500;
const originalSourceAttr = 'data-mt-original-src';
const readingAnchorAttr = 'data-mt-gomuraw-reading-anchor';
const imageAnchorAttr = 'data-mt-gomuraw-image-anchor';

export function isGomurawChapterPage(hostname: string, pathname: string): boolean {
  return (hostname === 'gomuraw.onl' || hostname === 'www.gomuraw.onl')
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
    if (!candidate || candidate.startsWith('blob:') || candidate.startsWith('data:')) continue;
    const url = toHttpUrl(candidate, baseUrl);
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
  for (const image of images) {
    const originalUrl = readGomurawOriginalUrl(image, baseUrl);
    if (!originalUrl) continue;
    const pageIndex = pages.length;
    pages.push({
      key: `${pathname}::${pageIndex}`,
      originalUrl,
      pageIndex,
    });
  }
  return pages;
}

function chapterImages(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll<HTMLImageElement>(
    '.read-viewer .page-chapter > img',
  ));
}

function chapterPageEntries(): Array<{ image: HTMLImageElement; target: ReadingPageTarget }> {
  const images = chapterImages();
  const entries: Array<{ image: HTMLImageElement; target: ReadingPageTarget }> = [];
  for (const image of images) {
    let originalUrl = readGomurawOriginalUrl(image, location.href);
    if (!originalUrl) continue;
    if (!image.hasAttribute(originalSourceAttr)) {
      image.setAttribute(originalSourceAttr, originalUrl);
      originalUrl = readGomurawOriginalUrl(image, location.href) ?? originalUrl;
    }
    const pageIndex = entries.length;
    entries.push({
      image,
      target: {
        key: `${location.pathname}::${pageIndex}`,
        originalUrl,
        pageIndex,
      },
    });
  }
  return entries;
}

function pageTargets(): ReadingPageTarget[] {
  return chapterPageEntries().map((entry) => entry.target);
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
        if (mutations.some((mutation) => mutation.type === 'childList')) onChange();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('popstate', onChange);

      return () => {
        observer.disconnect();
        window.removeEventListener('popstate', onChange);
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
      const pages = pageTargets();
      if (pages.length === 0) {
        return { status: 'incomplete', reason: 'metadata-unavailable' };
      }
      if (pages.length > maxChapterPages) {
        return {
          status: 'incomplete',
          reason: 'page-limit-exceeded',
          pageCount: pages.length,
          maxPages: maxChapterPages,
        };
      }
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
