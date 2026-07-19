import type { SiteAdapter } from '../core/types';
const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const originalSrcAttr = 'data-mt-original-src';
const pendingAppliedSources = new WeakMap<HTMLImageElement, string>();

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
  let bestContainsViewportCenter = false;
  let bestVisibleArea = 0;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;
  const images = dialog.querySelectorAll<HTMLImageElement>('img');
  for (const image of images) {
    if (!isDialogMediaImage(image)) continue;
    const rect = image.getBoundingClientRect();
    const visibleWidth = Math.max(
      0,
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
    );
    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
    );
    const visibleArea = visibleWidth * visibleHeight;
    if (visibleArea <= 0) continue;

    const imageCenterX = rect.left + rect.width / 2;
    const imageCenterY = rect.top + rect.height / 2;
    const containsViewportCenter = rect.left <= viewportCenterX
      && rect.right >= viewportCenterX
      && rect.top <= viewportCenterY
      && rect.bottom >= viewportCenterY;
    const centerDistance = Math.hypot(
      imageCenterX - viewportCenterX,
      imageCenterY - viewportCenterY,
    );
    if (
      (containsViewportCenter && !bestContainsViewportCenter)
      || (
        containsViewportCenter === bestContainsViewportCenter
        && (
          visibleArea > bestVisibleArea
          || (visibleArea === bestVisibleArea && centerDistance < bestCenterDistance)
        )
      )
    ) {
      bestContainsViewportCenter = containsViewportCenter;
      bestVisibleArea = visibleArea;
      bestCenterDistance = centerDistance;
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

function isExtensionSourceMutation(mutation: MutationRecord): boolean {
  if (
    mutation.type !== 'attributes'
    || mutation.attributeName !== 'src'
    || typeof HTMLImageElement === 'undefined'
    || !(mutation.target instanceof HTMLImageElement)
  ) {
    return false;
  }

  const pendingSource = pendingAppliedSources.get(mutation.target);
  if (!pendingSource) return false;
  pendingAppliedSources.delete(mutation.target);
  return mutation.target.src === pendingSource;
}

const referenceButtonSelector =
  '#layers > div:nth-child(2) > div > div > div > div > div > div.css-175oi2r.r-1ny4l3l.r-18u37iz.r-1pi2tsx.r-1777fci.r-1xcajam.r-ipm5af.r-g6jmlv.r-1awozwy > div.css-175oi2r.r-1wbh5a2.r-htvplk.r-1udh08x.r-17gur6a.r-1pi2tsx.r-13qz1uu > div.css-175oi2r.r-18u37iz.r-1pi2tsx.r-11yh6sk.r-buy8e9.r-bnwqim.r-13qz1uu > div.css-175oi2r.r-16y2uox.r-1wbh5a2 > div.css-175oi2r.r-1awozwy.r-1loqt21.r-1777fci.r-xyw6el.r-u8s1d.r-ipm5af.r-zchlnj';
const anchoredVerticalGapPx = 8;
const fallbackHostInsetPx = 16;

function repositionAnchor(anchor: HTMLElement, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const refButton = document.querySelector(referenceButtonSelector) as HTMLElement | null;
  if (!refButton || !isVisibleElement(refButton) || !dialog.contains(refButton)) {
    anchor.style.left = 'auto';
    anchor.style.right = `${fallbackHostInsetPx}px`;
    anchor.style.top = `${fallbackHostInsetPx}px`;
    return;
  }
  const refTarget = refButton.querySelector(':scope > button > div') ?? refButton;
  const refRect = refTarget.getBoundingClientRect();
  const dialogRect = dialog.getBoundingClientRect();

  const right = Math.max(0, Math.round(dialogRect.right - refRect.right));
  const top = Math.max(0, Math.round(refRect.bottom - dialogRect.top + anchoredVerticalGapPx));

  anchor.style.left = 'auto';
  anchor.style.right = `${right}px`;
  anchor.style.top = `${top}px`;
}

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
    anchor.dataset.theme = 'dark';
    anchor.style.cssText = `position:absolute; right:${fallbackHostInsetPx}px; top:${fallbackHostInsetPx}px; z-index:1000;`;

    if (dialog) {
      dialog.appendChild(anchor);

      let rafId = 0;

      const cleanup = () => {
        cancelAnimationFrame(rafId);
        resizeObserver.disconnect();
        dialog.removeEventListener('transitionend', onTransitionEnd);
        dialog.removeEventListener('transitionstart', onTransitionStart);
      };

      const reposition = () => {
        if (!anchor.isConnected) {
          cleanup();
          return;
        }
        repositionAnchor(anchor, dialog);
      };

      const startRafTracking = () => {
        cancelAnimationFrame(rafId);
        const tick = () => {
          if (!anchor.isConnected) { cleanup(); return; }
          repositionAnchor(anchor, dialog);
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      };

      const resizeObserver = new ResizeObserver(reposition);
      resizeObserver.observe(dialog);

      const onTransitionStart = (e: TransitionEvent) => {
        if (e.target instanceof HTMLElement && dialog.contains(e.target)) startRafTracking();
      };
      const onTransitionEnd = (e: TransitionEvent) => {
        if (e.target instanceof HTMLElement && dialog.contains(e.target)) {
          cancelAnimationFrame(rafId);
          reposition();
        }
      };
      dialog.addEventListener('transitionstart', onTransitionStart, { passive: true });
      dialog.addEventListener('transitionend', onTransitionEnd, { passive: true });
    } else {
      document.body.appendChild(anchor);
    }

    // Reposition after host is mounted and has layout dimensions
    requestAnimationFrame(() => {
      repositionAnchor(anchor, dialog);
    });

    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
    pendingAppliedSources.set(target.element, target.element.src);
    target.element.setAttribute(originalSrcAttr, target.originalUrl);
    updateImageCompanionBackground(target.element, url);
  },

  observe(onChange) {
    const root = document.querySelector('#layers') ?? document.body;
    const observer = new MutationObserver((mutations) => {
      let shouldSync = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          shouldSync = true;
          continue;
        }
        if (
          mutation.type === 'attributes'
          && (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')
          && !isExtensionSourceMutation(mutation)
        ) {
          shouldSync = true;
        }
      }
      if (shouldSync) onChange();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });

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
