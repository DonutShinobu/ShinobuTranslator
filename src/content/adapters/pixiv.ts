import type { ImageTarget, SiteAdapter, UrlTarget } from '../core/types';

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

/** Extract base URL pattern from a Pixiv original image link.
 *  e.g. https://i.pximg.net/img-original/img/2024/01/15/00/00/00/123456_p0.jpg
 *  Returns { base: "https://i.pximg.net/img-original/img/2024/01/15/00/00/00/123456", ext: ".jpg" }
 */
function extractBaseUrlPattern(url: string): { base: string; ext: string } | null {
  // Match up to _p0 (or any _pN) and capture the extension.
  const match = url.match(/^(https:\/\/i\.pximg\.net\/img-original\/img\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d+)_p\d+(\.\w+)$/);
  if (!match) return null;
  return { base: match[1], ext: match[2] };
}


// Track the bottom bar UI anchor so we reuse it across sync cycles.
let bottomBarAnchor: HTMLElement | null = null;

function getTotalPageCount(): number {
  // Primary: counter text near close icon. Reliable across single/double-page
  // modes and regardless of card-0 presence.
  const counterEl = document.querySelector('.gtm-manga-viewer-close-icon + div');
  if (counterEl) {
    const text = counterEl.textContent?.trim();
    const match = text?.match(/^\d+/);
    if (match) return parseInt(match[0], 10);
  }
  // Fallback: manga viewer slider. Only accurate in single-page mode without
  // card-0. Double-page spreads and card-0 both offset max from the true count.
  const slider = document.querySelector<HTMLInputElement>('.gtm-manga-viewer-change-page');
  if (slider) {
    const min = parseInt(slider.min, 10);
    const max = parseInt(slider.max, 10);
    if (max > 0) return min === 0 ? max - 1 : max;
  }
  // Last resort: count GTM links currently in the DOM.
  const links = document.querySelectorAll('.gtm-expand-full-size-illust');
  return links.length || 0;
}

function findAllPageUrls(): UrlTarget[] {
  // Strategy: find any .gtm-expand-full-size-illust link to get the base URL pattern,
  // then generate all page URLs from p0 to p{totalPages-1}.
  const links = document.querySelectorAll<HTMLAnchorElement>('.gtm-expand-full-size-illust');
  if (links.length === 0) return [];

  // Try to extract base pattern from any link that has an i.pximg.net href.
  let pattern: { base: string; ext: string } | null = null;
  for (const link of links) {
    if (link.href.includes('i.pximg.net')) {
      pattern = extractBaseUrlPattern(link.href);
      if (pattern) break;
    }
  }

  const totalPages = getTotalPageCount();
  if (totalPages === 0 || !pattern) return [];

  const targets: UrlTarget[] = [];
  for (let i = 0; i < totalPages; i++) {
    const originalUrl = `${pattern.base}_p${i}${pattern.ext}`;
    const key = extractPixivImageKey(originalUrl);
    targets.push({ key, originalUrl, pageIndex: i });
  }
  return targets;
}

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

export const pixivAdapter: SiteAdapter = {
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

  findAllPageUrls() {
    return findAllPageUrls();
  },

  getVisiblePages() {
    return getVisiblePages();
  },

  getTotalPageCount() {
    return getTotalPageCount();
  },

  createBottomBarAnchor() {
    return createBottomBarAnchor();
  },

  applyImageByKey(key, url) {
    applyImageByKey(key, url);
  },
};

// Export helpers for TranslatorCore to use directly.
export {
  isReadingMode,
  findAllPageUrls,
  getVisiblePages,
  getTotalPageCount,
  createBottomBarAnchor,
  applyImageByKey,
};
