import { shinobuBake, shinobuRender } from '../pipeline/bake';
import { browserPlatform } from '../runtime/browserPlatform';
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { ehentaiAdapter } from './adapters/ehentai';
import type { SiteAdapter } from './core/types';
import { TranslatorCore } from './core/TranslatorCore';
import { getChromeApi } from '../shared/chrome';
import { toErrorMessage } from '../shared/utils';
import {
  buildScreenshotElementCandidates,
  toDocumentScreenshotRect,
  toViewportScreenshotRect,
} from './core/screenshot';
import type { ScreenshotRect, ScreenshotSelection } from './core/screenshot';

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

/** The last right-click translation target. */
let contextMenuSelection: ScreenshotSelection | null = null;

function toElementScreenshotRect(element: Element): ScreenshotRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function toScreenshotSelection(rect: ScreenshotRect): ScreenshotSelection | null {
  const viewportRect = toViewportScreenshotRect(rect, window.innerWidth, window.innerHeight);
  if (viewportRect.width < 12 || viewportRect.height < 12) return null;
  return {
    viewportRect,
    documentRect: toDocumentScreenshotRect(viewportRect, window.scrollX, window.scrollY),
  };
}

function isShinobuUiElement(element: Element): boolean {
  return Boolean(element.closest('.mt-x-overlay-inline, .mt-x-reading-bar, .mt-x-screenshot-select, .mt-x-screenshot-result'));
}

function isContextMenuScreenshotElement(element: Element): boolean {
  if (isShinobuUiElement(element)) return false;
  if (element === document.body || element === document.documentElement) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function findContextMenuScreenshotSelection(event: MouseEvent): ScreenshotSelection | null {
  const elements: Element[] = [];
  const seen = new Set<Element>();
  const addElement = (element: Element | null): void => {
    if (!element || seen.has(element) || !isContextMenuScreenshotElement(element)) return;
    seen.add(element);
    elements.push(element);
  };

  for (const target of event.composedPath()) {
    if (target instanceof Element) addElement(target);
  }
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    addElement(element);
  }

  const candidates = buildScreenshotElementCandidates(
    elements.map((element) => ({
      element,
      rect: toElementScreenshotRect(element),
    })),
    { width: window.innerWidth, height: window.innerHeight },
  );
  const candidate = candidates.find((item) => item.area >= 1600) ?? candidates[0];
  return candidate ? toScreenshotSelection(candidate.rect) : null;
}

function findContextMenuSelection(event: MouseEvent): ScreenshotSelection | null {
  const target = event.target;
  if (target instanceof Element && isShinobuUiElement(target)) return null;
  if (target instanceof HTMLImageElement) {
    return toScreenshotSelection(toElementScreenshotRect(target));
  }
  return findContextMenuScreenshotSelection(event);
}

document.addEventListener('contextmenu', (event) => {
  contextMenuSelection = findContextMenuSelection(event);
}, true);

// Listen for context-menu translate requests from background
const chromeApi = getChromeApi();
if (chromeApi?.runtime?.onMessage?.addListener) {
  chromeApi.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'mt:context-menu-translate') {
      const selection = contextMenuSelection;
      contextMenuSelection = null;
      if (selection) {
        core.translateScreenshotSelection(selection).then(() => {
          sendResponse({ ok: true, type: 'mt:context-menu-translate' });
        }).catch((error: unknown) => {
          sendResponse({ ok: false, type: 'mt:context-menu-translate', error: toErrorMessage(error) });
        });
      } else {
        sendResponse({ ok: false, type: 'mt:context-menu-translate', error: '未找到可翻译区域' });
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
