import { shinobuBake, shinobuRender } from '../pipeline/bake';
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import type { SiteAdapter } from './core/types';
import { TranslatorCore } from './core/TranslatorCore';
import { toErrorMessage } from '../shared/utils';

(window as any).__shinobu_bake__ = shinobuBake;

// Bridge for benchmark baking: listen for postMessage from main world
window.addEventListener("message", async (event) => {
  if (event.data?.type === "__shinobu_bake_request__") {
    try {
      const result = await shinobuBake(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_bake_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_bake_response__", error: e.message }, "*");
    }
  } else if (event.data?.type === "__shinobu_render_request__") {
    try {
      const result = await shinobuRender(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_render_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_render_response__", error: e.message }, "*");
    }
  }
});
// Signal that the bake bridge is ready
window.postMessage({ type: "__shinobu_bake_ready__" }, "*");

/** Null adapter for non-supported sites — supports only context-menu translation. */
function createNullAdapter(): SiteAdapter {
  return {
    match: () => false,
    findImages: () => [],
    createUiAnchor: () => document.createElement('div'),
    applyImage: () => {},
    observe: () => () => {},
  };
}

const adapters = [twitterAdapter, pixivAdapter];
const adapter = adapters.find(a => a.match()) || createNullAdapter();
const core = new TranslatorCore(adapter);
core.start();

// --- Context menu support ---

/** The last image element the user right-clicked on. */
let contextMenuImage: HTMLImageElement | null = null;

document.addEventListener('contextmenu', (event) => {
  if (event.target instanceof HTMLImageElement) {
    contextMenuImage = event.target;
  } else {
    contextMenuImage = null;
  }
}, true);

// Listen for context-menu translate requests from background
const chromeApi = (globalThis as any).chrome;
if (chromeApi?.runtime?.onMessage?.addListener) {
  chromeApi.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: any) => {
  if (message && typeof message === 'object' && (message as any).type === 'mt:context-menu-translate') {
    if (contextMenuImage && contextMenuImage.isConnected) {
      const img = contextMenuImage;
      // Clear the reference so a stale image isn't reused
      contextMenuImage = null;
      core.contextMenuTranslate(img).then(() => {
        sendResponse({ ok: true, type: 'mt:context-menu-translate' });
      }).catch((err: unknown) => {
        sendResponse({ ok: false, type: 'mt:context-menu-translate', error: toErrorMessage(err) });
      });
    } else {
      sendResponse({ ok: false, type: 'mt:context-menu-translate', error: '未找到图片元素' });
    }
    return true; // keep message channel open for async response
  }
  });
}
