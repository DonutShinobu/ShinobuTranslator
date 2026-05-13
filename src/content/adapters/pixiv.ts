import type { ImageTarget, SiteAdapter } from '../core/types';

function extractPixivImageKey(url: string): string {
  const match = url.match(/(\d+_p\d+)/);
  return match ? match[1] : url;
}

export const pixivAdapter: SiteAdapter = {
  match() {
    return location.hostname === 'www.pixiv.net'
      && location.pathname.startsWith('/artworks/');
  },

  findImages() {
    const links = document.querySelectorAll<HTMLAnchorElement>('a.gtm-expand-full-size-illust');
    const targets: ImageTarget[] = [];
    for (const link of links) {
      const img = link.querySelector('img');
      if (!img || !link.href.includes('i.pximg.net')) continue;
      const key = extractPixivImageKey(link.href);
      targets.push({ element: img, key, originalUrl: link.href });
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
};
