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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

type ContextMenuTranslateTarget =
  | {
      kind: 'image';
      element: HTMLImageElement;
      originalUrl: string;
      documentRect: ScreenshotRect;
    }
  | {
      kind: 'screenshot';
      selection: ScreenshotSelection;
    };

type PointerPosition = {
  clientX: number;
  clientY: number;
};

/** The last right-click translation target. */
let contextMenuTarget: ContextMenuTranslateTarget | null = null;
let lastPointerPosition: PointerPosition | null = null;
let shortcutToastElement: HTMLElement | null = null;
let shortcutToastTimer: number | null = null;

function toElementScreenshotRect(element: Element): ScreenshotRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function toElementDocumentScreenshotRect(element: Element): ScreenshotRect {
  return toDocumentScreenshotRect(toElementScreenshotRect(element), window.scrollX, window.scrollY);
}

function isUsableScreenshotRect(rect: ScreenshotRect): boolean {
  return rect.width >= 12 && rect.height >= 12;
}

function toScreenshotSelection(rect: ScreenshotRect): ScreenshotSelection | null {
  const viewportRect = toViewportScreenshotRect(rect, window.innerWidth, window.innerHeight);
  if (!isUsableScreenshotRect(viewportRect)) return null;
  return {
    viewportRect,
    documentRect: toDocumentScreenshotRect(viewportRect, window.scrollX, window.scrollY),
  };
}

function isDirectImageResourceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, location.href);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    return hostname === 'pbs.twimg.com' ||
      hostname === 'i.pximg.net' ||
      hostname.endsWith('.pximg.net') ||
      /\.(?:avif|gif|jpe?g|png|webp)$/u.test(pathname);
  } catch {
    return false;
  }
}

function toAbsoluteUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl, location.href).toString();
  } catch {
    return rawUrl;
  }
}

function readContextImageOriginalUrl(image: HTMLImageElement): string {
  const storedOriginal = image.getAttribute('data-mt-original-src');
  if (storedOriginal && isDirectImageResourceUrl(storedOriginal)) {
    return toAbsoluteUrl(storedOriginal);
  }

  const directLink = image.closest<HTMLAnchorElement>('a[href]');
  if (directLink?.href && isDirectImageResourceUrl(directLink.href)) {
    return toAbsoluteUrl(directLink.href);
  }

  const imageUrl = image.currentSrc || image.src;
  if (!imageUrl || imageUrl.startsWith('blob:') || imageUrl.startsWith('data:')) {
    return '';
  }
  return toAbsoluteUrl(imageUrl);
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

function collectScreenshotCandidateElements(addCandidates: (addElement: (element: Element | null) => void) => void): Element[] {
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const addElement = (element: Element | null): void => {
    if (!element || seen.has(element) || !isContextMenuScreenshotElement(element)) return;
    seen.add(element);
    candidates.push(element);
  };
  addCandidates(addElement);
  return candidates;
}

function toScreenshotSelectionFromElements(elements: Element[]): ScreenshotSelection | null {
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

function findContextMenuScreenshotSelection(event: MouseEvent): ScreenshotSelection | null {
  const elements = collectScreenshotCandidateElements((addElement) => {
    for (const target of event.composedPath()) {
      if (target instanceof Element) addElement(target);
    }
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      addElement(element);
    }
  });
  return toScreenshotSelectionFromElements(elements);
}

function findContextMenuTarget(event: MouseEvent): ContextMenuTranslateTarget | null {
  const target = event.target;
  if (target instanceof Element && isShinobuUiElement(target)) return null;
  if (target instanceof HTMLImageElement) {
    const originalUrl = readContextImageOriginalUrl(target);
    const documentRect = toElementDocumentScreenshotRect(target);
    if (originalUrl && isUsableScreenshotRect(documentRect)) {
      return {
        kind: 'image',
        element: target,
        originalUrl,
        documentRect,
      };
    }
  }
  const selection = findContextMenuScreenshotSelection(event);
  return selection ? { kind: 'screenshot', selection } : null;
}

function isPointerInsideViewport(position: PointerPosition): boolean {
  return position.clientX >= 0 &&
    position.clientY >= 0 &&
    position.clientX <= window.innerWidth &&
    position.clientY <= window.innerHeight;
}

function updateLastPointerPosition(event: MouseEvent | PointerEvent): void {
  lastPointerPosition = {
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function showShortcutToast(message: string): void {
  if (!shortcutToastElement) {
    shortcutToastElement = document.createElement('div');
    shortcutToastElement.className = 'mt-x-shortcut-toast';
    document.body.appendChild(shortcutToastElement);
  }
  shortcutToastElement.textContent = message;
  shortcutToastElement.dataset.visible = 'true';
  if (shortcutToastTimer !== null) {
    window.clearTimeout(shortcutToastTimer);
  }
  shortcutToastTimer = window.setTimeout(() => {
    if (!shortcutToastElement) return;
    shortcutToastElement.remove();
    shortcutToastElement = null;
    shortcutToastTimer = null;
  }, 1800);
}

function findHoverScreenshotSelection(elementsFromPoint: Element[]): ScreenshotSelection | null {
  const elements = collectScreenshotCandidateElements((addElement) => {
    for (const element of elementsFromPoint) {
      let current: Element | null = element;
      while (current && current !== document.body && current !== document.documentElement) {
        addElement(current);
        current = current.parentElement;
      }
    }
  });
  return toScreenshotSelectionFromElements(elements);
}

function findHoverTranslateTarget(): ContextMenuTranslateTarget | null {
  if (!lastPointerPosition || !isPointerInsideViewport(lastPointerPosition)) {
    return null;
  }
  const elements = document.elementsFromPoint(lastPointerPosition.clientX, lastPointerPosition.clientY);
  const topElement = elements[0];
  if (!topElement || isShinobuUiElement(topElement)) {
    return null;
  }

  const hoverElement = elements.find((element) => isContextMenuScreenshotElement(element));
  if (!hoverElement) {
    return null;
  }

  if (hoverElement instanceof HTMLImageElement) {
    const originalUrl = readContextImageOriginalUrl(hoverElement);
    const documentRect = toElementDocumentScreenshotRect(hoverElement);
    if (originalUrl && isUsableScreenshotRect(documentRect)) {
      return {
        kind: 'image',
        element: hoverElement,
        originalUrl,
        documentRect,
      };
    }
  }

  const selection = findHoverScreenshotSelection(elements);
  return selection ? { kind: 'screenshot', selection } : null;
}

async function translateTarget(target: ContextMenuTranslateTarget): Promise<void> {
  if (target.kind === 'image') {
    await core.translateImageInFloatingOverlay(target.originalUrl, target.element, target.documentRect);
    return;
  }
  await core.translateScreenshotSelection(target.selection);
}

document.addEventListener('contextmenu', (event) => {
  contextMenuTarget = findContextMenuTarget(event);
}, true);
document.addEventListener('pointermove', updateLastPointerPosition, true);
document.addEventListener('mousemove', updateLastPointerPosition, true);
document.addEventListener('mouseleave', () => {
  lastPointerPosition = null;
}, true);

// Listen for context-menu translate requests from background
const chromeApi = getChromeApi();
if (chromeApi?.runtime?.onMessage?.addListener) {
  chromeApi.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'mt:context-menu-translate') {
      const target = contextMenuTarget;
      contextMenuTarget = null;
      if (target) {
        void (async () => {
          try {
            await translateTarget(target);
            sendResponse({ ok: true, type: 'mt:context-menu-translate' });
          } catch (error: unknown) {
            sendResponse({ ok: false, type: 'mt:context-menu-translate', error: toErrorMessage(error) });
          }
        })();
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

    if (message.type === 'mt:shortcut-translate-hover') {
      const target = findHoverTranslateTarget();
      if (!target) {
        showShortcutToast('未找到可翻译区域');
        sendResponse({ ok: false, type: 'mt:shortcut-translate-hover', error: '未找到可翻译区域' });
        return true;
      }
      void (async () => {
        try {
          await translateTarget(target);
          sendResponse({ ok: true, type: 'mt:shortcut-translate-hover' });
        } catch (error: unknown) {
          sendResponse({ ok: false, type: 'mt:shortcut-translate-hover', error: toErrorMessage(error) });
        }
      })();
      return true;
    }

    return false;
  });
}
