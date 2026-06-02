import { shinobuBake, shinobuRender } from '../pipeline/bake';
import { browserPlatform } from '../runtime/browserPlatform';
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { ehentaiAdapter } from './adapters/ehentai';
import type { SiteAdapter } from './core/types';
import { TranslatorCore } from './core/TranslatorCore';
import { getChromeApi } from '../shared/chrome';
import { toErrorMessage } from '../shared/utils';

type ShinobuWindow = typeof window & {
  __shinobu_bake__?: typeof shinobuBake;
};

(window as ShinobuWindow).__shinobu_bake__ = shinobuBake;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Bridge for benchmark baking: listen for postMessage from main world
window.addEventListener("message", async (event) => {
  if (event.data?.type === "__shinobu_bake_request__") {
    try {
      const result = await shinobuBake(event.data.dataUrl, browserPlatform);
      window.postMessage({ type: "__shinobu_bake_response__", result }, "*");
    } catch (error: unknown) {
      window.postMessage({ type: "__shinobu_bake_response__", error: toErrorMessage(error) }, "*");
    }
  } else if (event.data?.type === "__shinobu_render_request__") {
    try {
      const result = await shinobuRender(event.data.dataUrl, browserPlatform);
      window.postMessage({ type: "__shinobu_render_response__", result }, "*");
    } catch (error: unknown) {
      window.postMessage({ type: "__shinobu_render_response__", error: toErrorMessage(error) }, "*");
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

const adapters = [twitterAdapter, pixivAdapter, ehentaiAdapter];
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
const chromeApi = getChromeApi();
if (chromeApi?.runtime?.onMessage?.addListener) {
  chromeApi.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'mt:context-menu-translate') {
      if (contextMenuImage && contextMenuImage.isConnected) {
        const img = contextMenuImage;
        // Clear the reference so a stale image isn't reused.
        contextMenuImage = null;
        core.contextMenuTranslate(img).then(() => {
          sendResponse({ ok: true, type: 'mt:context-menu-translate' });
        }).catch((error: unknown) => {
          sendResponse({ ok: false, type: 'mt:context-menu-translate', error: toErrorMessage(error) });
        });
      } else {
        sendResponse({ ok: false, type: 'mt:context-menu-translate', error: '未找到图片元素' });
      }
      return true;
    }

    if (message.type === 'mt:start-screenshot-translate') {
      core.startScreenshotTranslate().then(() => {
        sendResponse({ ok: true, type: 'mt:start-screenshot-translate' });
      }).catch((error: unknown) => {
        sendResponse({ ok: false, type: 'mt:start-screenshot-translate', error: toErrorMessage(error) });
      });
      return true;
    }

    return false;
  });
}
