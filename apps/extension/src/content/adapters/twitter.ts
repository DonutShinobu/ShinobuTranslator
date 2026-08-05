import type {
  ImageTranslationContextResolution,
  SiteAdapter,
} from '../core/types';
const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const quotedTweetCardSelector = '[role="link"]:has([data-testid="Tweet-User-Avatar"])';
const quotedTweetMediaSelector = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video';
const originalSrcAttr = 'data-mt-original-src';
const maxTweetContextCacheEntries = 50;
const pendingAppliedSources = new WeakMap<HTMLImageElement, string>();
const fallbackTweetIdentities = new WeakMap<HTMLElement, string>();
const tweetContextCache = new Map<string, ImageTranslationContextResolution>();
let nextFallbackTweetIdentity = 1;

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

function readStatusId(rawPathOrUrl: string): string | null {
  const match = /\/status\/(\d+)(?:\/|$)/u.exec(rawPathOrUrl);
  return match?.[1] ?? null;
}

function getTweetIdentity(dialog: HTMLElement, originalUrl = ''): string {
  const pathStatusId = typeof location === 'undefined'
    ? null
    : readStatusId(location.pathname);
  if (pathStatusId) {
    return `status:${pathStatusId}`;
  }

  const statusLinks = typeof dialog.querySelectorAll === 'function'
    ? Array.from(dialog.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
    : [];
  for (const statusLink of statusLinks) {
    if (statusLink.closest?.(quotedTweetCardSelector)) continue;
    const linkedStatusId = readStatusId(statusLink.href);
    if (linkedStatusId) {
      return `status:${linkedStatusId}`;
    }
  }

  const timelineTweet = originalUrl
    ? findTimelineTweet(null, originalUrl)
    : null;
  const timelineStatusId = timelineTweet
    ? readCurrentTweetStatusId(timelineTweet)
    : null;
  if (timelineStatusId) {
    return `status:${timelineStatusId}`;
  }

  const existing = fallbackTweetIdentities.get(dialog);
  if (existing) return existing;
  const identity = `dialog:${nextFallbackTweetIdentity++}`;
  fallbackTweetIdentities.set(dialog, identity);
  return identity;
}

function normalizeTweetBody(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .trim();
}

function readTweetBody(element: HTMLElement): string {
  return normalizeTweetBody(element.innerText || element.textContent || '');
}

function getTranslationContextFromTweet(
  tweet: HTMLElement,
): ImageTranslationContextResolution {
  const bodies = Array.from(
    tweet.querySelectorAll<HTMLElement>('[data-testid="tweetText"]'),
  );
  const quoteCards = Array.from(
    tweet.querySelectorAll<HTMLElement>(quotedTweetCardSelector),
  );
  let currentTweetText = '';
  let quotedTweetText: string | undefined;

  for (const body of bodies) {
    const text = readTweetBody(body);
    if (quoteCards.some(card => card.contains(body))) {
      if (!quotedTweetText) {
        quotedTweetText = text;
      }
      continue;
    }
    if (!currentTweetText) {
      currentTweetText = text;
    }
  }

  for (const quoteCard of quoteCards) {
    const hasReadableBody = bodies.some(body => quoteCard.contains(body));
    if (!hasReadableBody && !quoteCard.querySelector(quotedTweetMediaSelector)) {
      return { status: 'unavailable' as const };
    }
    quotedTweetText ??= '';
  }

  if (!currentTweetText && !quotedTweetText) {
    return { status: 'empty' as const };
  }
  return {
    status: 'available' as const,
    context: {
      source: 'x_tweet' as const,
      currentTweetText,
      ...(quotedTweetText === undefined ? {} : { quotedTweetText }),
    },
  };
}

function getTranslationContextFromDialog(
  dialog: HTMLElement,
): ImageTranslationContextResolution {
  const tweet = dialog.querySelector<HTMLElement>('article[data-testid="tweet"]');
  return tweet
    ? getTranslationContextFromTweet(tweet)
    : { status: 'unavailable' };
}

function readCurrentTweetStatusId(tweet: HTMLElement): string | null {
  const statusLinks = Array.from(
    tweet.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'),
  );
  for (const statusLink of statusLinks) {
    if (statusLink.closest?.(quotedTweetCardSelector)) continue;
    const statusId = readStatusId(statusLink.href);
    if (statusId) return statusId;
  }
  return null;
}

function readStatusIdFromTweetIdentity(tweetIdentity: string | null): string | null {
  if (!tweetIdentity) return null;
  const match = /^status:(\d+)$/u.exec(tweetIdentity);
  return match?.[1] ?? null;
}

function findTimelineTweet(
  tweetIdentity: string | null,
  originalUrl: string,
): HTMLElement | null {
  if (
    typeof document === 'undefined'
    || typeof document.querySelectorAll !== 'function'
  ) {
    return null;
  }

  const tweets = Array.from(
    document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'),
  );
  const statusId = readStatusIdFromTweetIdentity(tweetIdentity);
  if (statusId) {
    const statusMatch = tweets.find(tweet => readCurrentTweetStatusId(tweet) === statusId);
    if (statusMatch) return statusMatch;
  }

  const mediaIdentity = getTwitterMediaIdentity(originalUrl);
  if (!mediaIdentity) return null;
  for (const tweet of tweets) {
    const mediaImages = Array.from(tweet.querySelectorAll<HTMLImageElement>('img'));
    for (const image of mediaImages) {
      if (image.closest?.(quotedTweetCardSelector)) continue;
      const imageUrl = image.currentSrc || image.src;
      if (getTwitterMediaIdentity(imageUrl) === mediaIdentity) {
        return tweet;
      }
    }
  }
  return null;
}

function resolveLiveTweetContext(
  dialog: HTMLElement | null,
  tweetIdentity: string | null,
  originalUrl: string,
): ImageTranslationContextResolution {
  if (dialog) {
    const dialogResolution = getTranslationContextFromDialog(dialog);
    if (dialogResolution.status !== 'unavailable') {
      return dialogResolution;
    }
  }

  const timelineTweet = findTimelineTweet(tweetIdentity, originalUrl);
  return timelineTweet
    ? getTranslationContextFromTweet(timelineTweet)
    : { status: 'unavailable' };
}

function rememberTweetContext(
  tweetIdentity: string,
  resolution: ImageTranslationContextResolution,
): void {
  if (resolution.status === 'unavailable') return;

  tweetContextCache.delete(tweetIdentity);
  tweetContextCache.set(tweetIdentity, resolution);
  if (tweetContextCache.size <= maxTweetContextCacheEntries) return;

  const oldestTweetIdentity = tweetContextCache.keys().next().value;
  if (oldestTweetIdentity !== undefined) {
    tweetContextCache.delete(oldestTweetIdentity);
  }
}

function readCachedTweetContext(
  tweetIdentity: string,
): ImageTranslationContextResolution | undefined {
  const cached = tweetContextCache.get(tweetIdentity);
  if (!cached) return undefined;

  tweetContextCache.delete(tweetIdentity);
  tweetContextCache.set(tweetIdentity, cached);
  return cached;
}

function readTweetIdentityFromImageKey(key: string): string | null {
  const separatorIndex = key.indexOf('::');
  return separatorIndex > 0 ? key.slice(0, separatorIndex) : null;
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

const anchoredVerticalGapPx = 8;
const fallbackHostInsetPx = 16;
const topControlBandHeightPx = 96;
const maxReferenceControlSizePx = 72;

function applyFallbackAnchorPosition(anchor: HTMLElement): void {
  anchor.style.left = 'auto';
  anchor.style.right = `${fallbackHostInsetPx}px`;
  anchor.style.top = `${fallbackHostInsetPx}px`;
  anchor.dataset.positionSource = 'fallback';
}

function isReferenceControlCandidate(
  control: HTMLButtonElement,
  dialog: HTMLElement,
  image: HTMLImageElement,
  anchor: HTMLElement,
): boolean {
  if (
    !control.isConnected
    || !dialog.contains(control)
    || anchor.contains(control)
    || !isVisibleElement(control)
  ) {
    return false;
  }

  const controlRect = control.getBoundingClientRect();
  const dialogRect = dialog.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  const topBandBottom = Math.min(dialogRect.bottom, dialogRect.top + topControlBandHeightPx);
  const controlCenterX = controlRect.left + controlRect.width / 2;
  const imageCenterX = imageRect.left + imageRect.width / 2;

  return controlRect.width <= maxReferenceControlSizePx
    && controlRect.height <= maxReferenceControlSizePx
    && controlRect.top >= dialogRect.top - 1
    && controlRect.bottom <= topBandBottom
    && controlRect.left >= dialogRect.left - 1
    && controlRect.right <= dialogRect.right + 1
    && controlCenterX >= imageCenterX;
}

function findReferenceControl(
  dialog: HTMLElement,
  image: HTMLImageElement,
  anchor: HTMLElement,
): HTMLButtonElement | null {
  const imageRect = image.getBoundingClientRect();
  let best: HTMLButtonElement | null = null;
  let bestHorizontalDistance = Number.POSITIVE_INFINITY;
  let bestRight = Number.NEGATIVE_INFINITY;

  for (const control of dialog.querySelectorAll<HTMLButtonElement>('button')) {
    if (!isReferenceControlCandidate(control, dialog, image, anchor)) continue;
    const controlRect = control.getBoundingClientRect();
    const horizontalDistance = Math.abs(controlRect.right - imageRect.right);
    if (
      horizontalDistance < bestHorizontalDistance
      || (horizontalDistance === bestHorizontalDistance && controlRect.right > bestRight)
    ) {
      best = control;
      bestHorizontalDistance = horizontalDistance;
      bestRight = controlRect.right;
    }
  }

  return best;
}

function repositionAnchor(
  anchor: HTMLElement,
  dialog: HTMLElement | null,
  image: HTMLImageElement,
  currentReference: HTMLButtonElement | null,
): HTMLButtonElement | null {
  if (!dialog) return null;
  const reference = currentReference && isReferenceControlCandidate(
    currentReference,
    dialog,
    image,
    anchor,
  )
    ? currentReference
    : findReferenceControl(dialog, image, anchor);
  if (!reference) {
    applyFallbackAnchorPosition(anchor);
    return null;
  }

  const refRect = reference.getBoundingClientRect();
  const dialogRect = dialog.getBoundingClientRect();

  const right = Math.max(0, Math.round(dialogRect.right - refRect.right));
  const top = Math.max(0, Math.round(refRect.bottom - dialogRect.top + anchoredVerticalGapPx));

  anchor.style.left = 'auto';
  anchor.style.right = `${right}px`;
  anchor.style.top = `${top}px`;
  anchor.dataset.positionSource = 'native-control';
  return reference;
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
    const tweetIdentity = getTweetIdentity(dialog, originalUrl);
    rememberTweetContext(
      tweetIdentity,
      resolveLiveTweetContext(dialog, tweetIdentity, originalUrl),
    );
    const key = `${tweetIdentity}::${normalizeImageKey(originalUrl)}`;
    image.setAttribute(originalSrcAttr, originalUrl);
    return [{ element: image, key, originalUrl }];
  },

  getTranslationContext(target) {
    const dialog = target.element.closest(imageDialogSelector) as HTMLElement | null;
    const tweetIdentity = readTweetIdentityFromImageKey(target.key)
      ?? (dialog ? getTweetIdentity(dialog, target.originalUrl) : null);
    const liveResolution = resolveLiveTweetContext(
      dialog,
      tweetIdentity,
      target.originalUrl,
    );
    if (liveResolution.status !== 'unavailable') {
      if (tweetIdentity) {
        rememberTweetContext(tweetIdentity, liveResolution);
      }
      return liveResolution;
    }
    return tweetIdentity
      ? readCachedTweetContext(tweetIdentity) ?? liveResolution
      : liveResolution;
  },

  keepTranslationActivityOnUnmount(target, currentTargets) {
    const tweetIdentity = readTweetIdentityFromImageKey(target.key);
    return tweetIdentity !== null && currentTargets.some(
      current => readTweetIdentityFromImageKey(current.key) === tweetIdentity,
    );
  },

  createUiAnchor(target) {
    const dialog = target.element.closest(imageDialogSelector) as HTMLElement | null;
    const anchor = document.createElement('div');
    anchor.dataset.theme = 'dark';
    anchor.dataset.positionSource = 'fallback';
    anchor.style.cssText = `position:absolute; right:${fallbackHostInsetPx}px; top:${fallbackHostInsetPx}px; z-index:1000;`;

    if (dialog) {
      dialog.appendChild(anchor);

      let referenceControl: HTMLButtonElement | null = null;
      let scheduledRafId: number | null = null;
      let trackingRafId: number | null = null;
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (scheduledRafId !== null) cancelAnimationFrame(scheduledRafId);
        if (trackingRafId !== null) cancelAnimationFrame(trackingRafId);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        dialog.removeEventListener('transitionend', onTransitionEnd);
        dialog.removeEventListener('transitionstart', onTransitionStart);
      };

      const reposition = () => {
        if (!anchor.isConnected) {
          cleanup();
          return;
        }
        referenceControl = repositionAnchor(
          anchor,
          dialog,
          target.element,
          referenceControl,
        );
      };

      const scheduleReposition = () => {
        if (scheduledRafId !== null || cleanedUp) return;
        scheduledRafId = requestAnimationFrame(() => {
          scheduledRafId = null;
          reposition();
        });
      };

      const startRafTracking = () => {
        if (scheduledRafId !== null) {
          cancelAnimationFrame(scheduledRafId);
          scheduledRafId = null;
        }
        if (trackingRafId !== null) cancelAnimationFrame(trackingRafId);
        const tick = () => {
          if (!anchor.isConnected) { cleanup(); return; }
          reposition();
          trackingRafId = requestAnimationFrame(tick);
        };
        trackingRafId = requestAnimationFrame(tick);
      };

      const resizeObserver = new ResizeObserver(scheduleReposition);
      resizeObserver.observe(dialog);
      const mutationObserver = new MutationObserver((mutations) => {
        if (mutations.some(mutation => !anchor.contains(mutation.target))) {
          scheduleReposition();
        }
      });
      mutationObserver.observe(dialog, { childList: true, subtree: true });

      const onTransitionStart = (e: TransitionEvent) => {
        if (e.target instanceof HTMLElement && dialog.contains(e.target)) startRafTracking();
      };
      const onTransitionEnd = (e: TransitionEvent) => {
        if (e.target instanceof HTMLElement && dialog.contains(e.target)) {
          if (trackingRafId !== null) {
            cancelAnimationFrame(trackingRafId);
            trackingRafId = null;
          }
          scheduleReposition();
        }
      };
      dialog.addEventListener('transitionstart', onTransitionStart, { passive: true });
      dialog.addEventListener('transitionend', onTransitionEnd, { passive: true });
      scheduleReposition();
    } else {
      document.body.appendChild(anchor);
    }

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
