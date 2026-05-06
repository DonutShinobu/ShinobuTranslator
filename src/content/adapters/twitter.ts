import type { SiteAdapter } from '../core/types';

const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const originalSrcAttr = 'data-mt-original-src';

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 32 || rect.height < 32) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isMediaImageSource(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('blob:')) return true;
  return src.includes('pbs.twimg.com/media/');
}

function isDialogMediaImage(image: HTMLImageElement): boolean {
  if (!isVisibleElement(image)) return false;
  const src = image.currentSrc || image.src;
  if (!isMediaImageSource(src)) return false;
  if (src.startsWith('blob:') && !image.hasAttribute(originalSrcAttr)) return false;
  return true;
}

function normalizeImageKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com') return url.toString();
    const format = url.searchParams.get('format');
    const base = `${url.origin}${url.pathname}`;
    return format ? `${base}?format=${format}` : base;
  } catch {
    return rawUrl;
  }
}

function findPhotoDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(imageDialogSelector));
  for (const dialog of dialogs) {
    if (!isVisibleElement(dialog)) continue;
    if (findCurrentImage(dialog)) return dialog;
  }
  return null;
}

function findCurrentImage(dialog: HTMLElement): HTMLImageElement | null {
  const centerElement = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const centerImage =
    centerElement instanceof HTMLImageElement
      ? centerElement
      : centerElement?.closest?.('img') instanceof HTMLImageElement
        ? (centerElement.closest('img') as HTMLImageElement)
        : null;
  if (centerImage && dialog.contains(centerImage) && isDialogMediaImage(centerImage)) {
    return centerImage;
  }

  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  const images = dialog.querySelectorAll<HTMLImageElement>('img');
  for (const image of images) {
    if (!isDialogMediaImage(image)) continue;
    const rect = image.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = image;
    }
  }
  return best;
}

function readImageOriginalUrl(image: HTMLImageElement): string {
  const src = image.currentSrc || image.src;
  const attrOriginal = image.getAttribute(originalSrcAttr);
  if (attrOriginal) {
    if (!src || src.startsWith('blob:')) return attrOriginal;
    const leftId = getTwitterMediaIdentity(attrOriginal);
    const rightId = getTwitterMediaIdentity(src);
    if (leftId && rightId && leftId === rightId) return attrOriginal;
    image.removeAttribute(originalSrcAttr);
  }
  if (!src || src.startsWith('blob:')) return '';
  return src;
}

function getTwitterMediaIdentity(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return null;
    const format = url.searchParams.get('format');
    return format ? `${url.pathname}?format=${format}` : url.pathname;
  } catch {
    return null;
  }
}

function updateImageCompanionBackground(image: HTMLImageElement, targetUrl: string): void {
  const previous = image.previousElementSibling;
  if (!previous || !(previous instanceof HTMLElement)) return;
  if (!previous.style.backgroundImage) return;
  previous.style.backgroundImage = `url("${targetUrl}")`;
}

const referenceButtonSelector =
  '#layers > div:nth-child(2) > div > div > div > div > div > div.css-175oi2r.r-1ny4l3l.r-18u37iz.r-1pi2tsx.r-1777fci.r-1xcajam.r-ipm5af.r-g6jmlv.r-1awozwy > div.css-175oi2r.r-1wbh5a2.r-htvplk.r-1udh08x.r-17gur6a.r-1pi2tsx.r-13qz1uu > div.css-175oi2r.r-18u37iz.r-1pi2tsx.r-11yh6sk.r-buy8e9.r-bnwqim.r-13qz1uu > div.css-175oi2r.r-16y2uox.r-1wbh5a2 > div.css-175oi2r.r-1awozwy.r-1loqt21.r-1777fci.r-xyw6el.r-u8s1d.r-ipm5af.r-zchlnj';
const anchoredVerticalGapPx = 8;
const fallbackHostInsetPx = 16;

export const twitterAdapter: SiteAdapter = {
  match() {
    const host = location.hostname;
    return host === 'x.com' || host === 'twitter.com';
  },

  findImages() {
    const dialog = findPhotoDialog();
    if (!dialog) return [];
    const image = findCurrentImage(dialog);
    if (!image) return [];
    const originalUrl = readImageOriginalUrl(image);
    if (!originalUrl) return [];
    const key = normalizeImageKey(originalUrl);
    image.setAttribute(originalSrcAttr, originalUrl);
    return [{ element: image, key, originalUrl }];
  },

  createUiAnchor(target) {
    const dialog = target.element.closest(imageDialogSelector) as HTMLElement | null;
    const anchor = document.createElement('div');
    anchor.style.cssText = `position:absolute; right:${fallbackHostInsetPx}px; top:${fallbackHostInsetPx}px; z-index:1000;`;

    const refButton = document.querySelector(referenceButtonSelector) as HTMLElement | null;
    if (dialog && refButton && isVisibleElement(refButton) && dialog.contains(refButton)) {
      const anchorRect = refButton.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const left = anchorRect.right - dialogRect.left - 200;
      const top = anchorRect.bottom - dialogRect.top + anchoredVerticalGapPx;
      anchor.style.cssText = `position:absolute; left:${Math.max(0, Math.round(left))}px; top:${Math.max(0, Math.round(top))}px; z-index:1000;`;
    }

    if (dialog) {
      dialog.appendChild(anchor);
    } else {
      document.body.appendChild(anchor);
    }
    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
    target.element.setAttribute(originalSrcAttr, target.originalUrl);
    updateImageCompanionBackground(target.element, url);
  },

  observe(onChange) {
    const root = document.querySelector('#layers') ?? document.body;
    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((m) => m.type === 'childList')) return;
      onChange();
    });
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
};
