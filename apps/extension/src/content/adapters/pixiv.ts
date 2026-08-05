import type {
  ImageTarget,
  ReadingPageDiscovery,
  SiteAdapter,
  UrlTarget,
} from '../core/types';

type LoadArtworkPages = (
  artworkId: string,
  signal: AbortSignal,
) => Promise<unknown>;

export type PixivAdapterDependencies = {
  loadArtworkPages?: LoadArtworkPages;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getArtworkId(): string | null {
  const match = location.pathname.match(/^\/artworks\/(\d+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function parseArtworkPageUrl(value: string, artworkId: string): UrlTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const pageMatch = parsed.pathname.match(/\/(\d+)_p(\d+)\.[^/]+$/);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'i.pximg.net'
    || pageMatch?.[1] !== artworkId
  ) {
    return null;
  }
  const pageIndex = Number(pageMatch[2]);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null;
  return {
    key: `${artworkId}_p${pageIndex}`,
    originalUrl: parsed.href,
    pageIndex,
  };
}

function parseArtworkPagesResponse(
  value: unknown,
  artworkId: string,
): readonly UrlTarget[] | null {
  if (!isRecord(value) || value.error !== false || !Array.isArray(value.body) || value.body.length === 0) {
    return null;
  }

  const pages: UrlTarget[] = [];
  for (let pageIndex = 0; pageIndex < value.body.length; pageIndex++) {
    const page = value.body[pageIndex];
    if (!isRecord(page) || !isRecord(page.urls) || typeof page.urls.original !== 'string') {
      return null;
    }
    const target = parseArtworkPageUrl(page.urls.original, artworkId);
    if (!target || target.pageIndex !== pageIndex) return null;
    pages.push(target);
  }
  return pages;
}

async function loadArtworkPages(
  artworkId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/ajax/illust/${artworkId}/pages`, {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(`Pixiv page discovery failed with HTTP ${response.status}`);
  return response.json();
}

function extractPixivImageKey(url: string): string {
  const match = url.match(/(\d+_p\d+)/);
  return match ? match[1] : url;
}

// --- Reading mode detection and helpers ---------------------------------------

function isReadingMode(): boolean {
  // Reading mode is triggered by URL hash (#1 etc) or presence of manga viewer container.
  if (location.hash && /^#\d+$/.test(location.hash)) return true;
  // Check for the manga viewer container (has GTM close icon).
  return !!document.querySelector('.gtm-manga-viewer-close-icon');
}

function readEmbeddedArtworkPages(artworkId: string): readonly UrlTarget[] | null {
  const preload = document.querySelector<HTMLMetaElement>(
    'meta#meta-preload-data, meta[name="preload-data"]',
  );
  if (!preload?.content) return null;
  let data: unknown;
  try {
    data = JSON.parse(preload.content);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.illust)) return null;
  const artwork = data.illust[artworkId];
  if (
    !isRecord(artwork)
    || typeof artwork.pageCount !== 'number'
    || !isRecord(artwork.urls)
    || typeof artwork.urls.original !== 'string'
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(artwork.pageCount)
    || artwork.pageCount <= 0
    || artwork.pageCount > 10_000
  ) {
    return null;
  }

  const pagesByIndex = new Map<number, UrlTarget>();
  const metadataPage = parseArtworkPageUrl(artwork.urls.original, artworkId);
  if (metadataPage) pagesByIndex.set(metadataPage.pageIndex, metadataPage);
  const links = typeof document.querySelectorAll === 'function'
    ? document.querySelectorAll<HTMLAnchorElement>('.gtm-expand-full-size-illust')
    : [];
  for (const link of links) {
    const page = parseArtworkPageUrl(link.href, artworkId);
    if (page && page.pageIndex < artwork.pageCount) pagesByIndex.set(page.pageIndex, page);
  }
  if (pagesByIndex.size !== artwork.pageCount) return null;
  const pages: UrlTarget[] = [];
  for (let pageIndex = 0; pageIndex < artwork.pageCount; pageIndex++) {
    const page = pagesByIndex.get(pageIndex);
    if (!page) return null;
    pages.push(page);
  }
  return pages;
}


// Track the bottom bar UI anchor so we reuse it across sync cycles.
let bottomBarAnchor: HTMLElement | null = null;

function getVisiblePages(): ImageTarget[] {
  // Use the page slider to determine which pages are currently being viewed.
  const slider = document.querySelector<HTMLInputElement>('.gtm-manga-viewer-change-page');
  if (!slider) return [];

  const sliderValue = parseInt(slider.value, 10);
  const sliderStep = parseInt(slider.step, 10) || 2;
  const isSinglePage = sliderStep === 1;

  // In single-page mode (step=1): only one page visible at a time.
  // In double-page spread (step=2): slider=1 → page 1 only; slider>1 → pages (v-1) and v.
  const pageNumbers: number[] = [sliderValue];
  if (!isSinglePage && sliderValue > 1) {
    pageNumbers.push(sliderValue - 1);
  }

  const allLinks = document.querySelectorAll<HTMLAnchorElement>('.gtm-expand-full-size-illust');
  const targets: ImageTarget[] = [];
  for (const link of allLinks) {
    const dataPage = parseInt(link.getAttribute('data-page') || '0', 10);
    if (!pageNumbers.includes(dataPage)) continue;
    const img = link.querySelector<HTMLImageElement>('img');
    if (!img || !link.href.includes('i.pximg.net')) continue;
    const key = extractPixivImageKey(link.href);
    targets.push({ element: img, key, originalUrl: link.href });
  }
  // Sort by data-page so translation order is predictable
  targets.sort((a, b) => {
    const ap = parseInt((a.element.closest('a') as HTMLAnchorElement)?.getAttribute('data-page') || '0', 10);
    const bp = parseInt((b.element.closest('a') as HTMLAnchorElement)?.getAttribute('data-page') || '0', 10);
    return ap - bp;
  });
  return targets;
}

function createBottomBarAnchor(): HTMLElement | null {
  if (bottomBarAnchor && bottomBarAnchor.isConnected) {
    return bottomBarAnchor;
  }

  // Find the direction toggle button — insert our buttons to its left.
  const directionToggle = document.querySelector('.gtm-manga-viewer-change-direction');
  if (!directionToggle) return null;

  // directionToggle is a BUTTON inside a wrapper DIV inside the controls flex container.
  // Insert the anchor before the wrapper DIV so it appears to the left.
  const wrapper = directionToggle.parentElement;
  if (!wrapper) return null;

  const anchor = document.createElement('div');
  anchor.setAttribute('data-mt-reading-bar', '');
  anchor.dataset.theme = 'light';
  anchor.style.cssText = 'display:flex; align-items:center; gap:8px; margin-right:12px;';

  wrapper.before(anchor);

  bottomBarAnchor = anchor;
  return anchor;
}

function applyImageByKey(key: string, url: string): void {
  // Try to find and apply to any visible img for this key right now.
  const links = document.querySelectorAll<HTMLAnchorElement>('.gtm-expand-full-size-illust');
  for (const link of links) {
    if (extractPixivImageKey(link.href) !== key) continue;
    const img = link.querySelector<HTMLImageElement>('img');
    if (img) {
      img.src = url;
    }
  }
}

// --- Normal mode helpers -------------------------------------------------------

function findNormalModeImages(): ImageTarget[] {
  // Normal view: single image p0 inside figure.
  const links = document.querySelectorAll<HTMLAnchorElement>('a.gtm-expand-full-size-illust');
  if (links.length > 0 && isReadingMode()) {
    // In reading mode, don't use normal mode finder.
    return [];
  }
  // Fallback: find the main artwork image in normal view.
  const img = document.querySelector<HTMLImageElement>('figure img');
  if (!img) return [];
  const link = img.closest<HTMLAnchorElement>('a');
  const originalUrl = link?.href || img.src;
  if (!originalUrl.includes('i.pximg.net')) return [];
  const key = extractPixivImageKey(originalUrl);
  return [{ element: img, key, originalUrl }];
}

// --- Adapter ------------------------------------------------------------------

export function createPixivAdapter(
  dependencies: PixivAdapterDependencies = {},
): SiteAdapter {
  const requestArtworkPages = dependencies.loadArtworkPages ?? loadArtworkPages;
  let activeArtworkId: string | null = null;
  let cachedDiscovery: { artworkId: string; result: ReadingPageDiscovery } | null = null;
  let inFlightDiscovery: {
    artworkId: string;
    abortController: AbortController;
    promise: Promise<ReadingPageDiscovery>;
  } | null = null;

  const syncArtworkContext = (): string | null => {
    const artworkId = getArtworkId();
    if (activeArtworkId === artworkId) return artworkId;
    activeArtworkId = artworkId;
    cachedDiscovery = null;
    inFlightDiscovery?.abortController.abort();
    inFlightDiscovery = null;
    return artworkId;
  };

  return {
  match() {
    return location.hostname === 'www.pixiv.net'
      && location.pathname.startsWith('/artworks/');
  },

  findImages() {
    if (isReadingMode()) {
      // In reading mode, we use bottom bar buttons, NOT per-image overlays.
      // Return empty so TranslatorCore doesn't mount per-image UI.
      // The reading mode logic is handled separately by TranslatorCore.
      return [];
    }
    // Normal view: only p0.
    const links = document.querySelectorAll<HTMLAnchorElement>('a.gtm-expand-full-size-illust');
    const targets: ImageTarget[] = [];
    for (const link of links) {
      const img = link.querySelector('img');
      if (!img || !link.href.includes('i.pximg.net')) continue;
      const key = extractPixivImageKey(link.href);
      targets.push({ element: img, key, originalUrl: link.href });
    }
    // If no GTM links found (single-image work in normal view), try figure img.
    if (targets.length === 0) {
      return findNormalModeImages();
    }
    return targets;
  },

  createUiAnchor(target) {
    const existingAnchor = target.element.closest('.sc-fddeba56-0')?.querySelector('[data-mt-pixiv-anchor]');
    if (existingAnchor instanceof HTMLElement) return existingAnchor;

    const wrapper = target.element.closest('.sc-fddeba56-0') as HTMLElement | null;
    if (wrapper) {
      wrapper.style.position = 'relative';
    }
    const anchor = document.createElement('div');
    anchor.setAttribute('data-mt-pixiv-anchor', '');
    anchor.dataset.theme = 'light';
    anchor.style.cssText = 'position:absolute; right:12px; top:12px; z-index:10;';
    (wrapper || target.element.parentElement!).appendChild(anchor);
    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
  },

  observe(onChange) {
    const observer = new MutationObserver(() => onChange());
    const root = document.querySelector('#root') || document.body;
    observer.observe(root, { childList: true, subtree: true });

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = (...args) => { origPush.apply(history, args); onChange(); };
    history.replaceState = (...args) => { origReplace.apply(history, args); onChange(); };
    window.addEventListener('popstate', onChange);

    return () => {
      observer.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onChange);
    };
  },

  isReadingMode() {
    return isReadingMode();
  },

  getReadingContextKey() {
    return syncArtworkContext();
  },

  discoverReadingPages(signal) {
    const artworkId = syncArtworkContext();
    if (!artworkId) {
      return Promise.resolve({
        status: 'incomplete',
        reason: 'metadata-unavailable',
      });
    }
    if (cachedDiscovery?.artworkId === artworkId) {
      return Promise.resolve(cachedDiscovery.result);
    }
    if (inFlightDiscovery?.artworkId === artworkId) {
      return inFlightDiscovery.promise;
    }
    const abortController = new AbortController();
    const abortDiscovery = () => abortController.abort(signal?.reason);
    signal?.addEventListener('abort', abortDiscovery, { once: true });
    if (signal?.aborted) abortDiscovery();
    const promise = requestArtworkPages(artworkId, abortController.signal)
      .then((response): ReadingPageDiscovery => {
        if (abortController.signal.aborted || activeArtworkId !== artworkId) {
          return { status: 'incomplete', reason: 'request-failed' };
        }
        const pages = parseArtworkPagesResponse(response, artworkId)
          ?? readEmbeddedArtworkPages(artworkId);
        const result: ReadingPageDiscovery = pages
          ? { status: 'complete', pages }
          : { status: 'incomplete', reason: 'invalid-response' };
        if (result.status === 'complete') {
          cachedDiscovery = { artworkId, result };
        }
        return result;
      })
      .catch((): ReadingPageDiscovery => {
        if (abortController.signal.aborted || activeArtworkId !== artworkId) {
          return { status: 'incomplete', reason: 'request-failed' };
        }
        const pages = readEmbeddedArtworkPages(artworkId);
        if (!pages) return { status: 'incomplete', reason: 'request-failed' };
        const result: ReadingPageDiscovery = { status: 'complete', pages };
        cachedDiscovery = { artworkId, result };
        return result;
      })
      .finally(() => {
        signal?.removeEventListener('abort', abortDiscovery);
        if (inFlightDiscovery?.promise === promise) inFlightDiscovery = null;
      });
    inFlightDiscovery = { artworkId, abortController, promise };
    return promise;
  },

  getVisiblePages() {
    return getVisiblePages();
  },

  createBottomBarAnchor() {
    return createBottomBarAnchor();
  },

  applyImageByKey(key, url) {
    applyImageByKey(key, url);
  },
  };
}

export const pixivAdapter = createPixivAdapter();

// Export helpers for TranslatorCore to use directly.
export {
  isReadingMode,
  getVisiblePages,
  createBottomBarAnchor,
  applyImageByKey,
};
