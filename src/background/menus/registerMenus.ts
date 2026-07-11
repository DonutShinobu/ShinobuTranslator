import { getChromeApi } from '../../shared/chrome';
import type { RuntimeMessage } from '../../shared/messages';

export const translateImageMenuId = 'translate-image';
export const translateScreenshotMenuId = 'translate-screenshot';
export const startScreenshotTranslateCommand = 'start-screenshot-translate';
export const translateHoverTargetCommand = 'translate-hover-target';

function createContextMenus(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.contextMenus?.create) return;
  chromeApi.contextMenus.create({
    id: translateImageMenuId,
    title: '翻译图片',
    contexts: ['all'],
  });
  chromeApi.contextMenus.create({
    id: translateScreenshotMenuId,
    title: '截图翻译',
    contexts: ['all'],
  });
}

function sendTabMessage(tabId: number, message: RuntimeMessage): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.sendMessage) return;
  chromeApi.tabs.sendMessage(tabId, message).catch(() => {
    // content script may not be injected yet — ignore
  });
}

export function registerMenusAndCommands(): void {
  const chromeApi = getChromeApi();
  if (chromeApi?.contextMenus?.create) {
    if (chromeApi.contextMenus.removeAll) {
      chromeApi.contextMenus.removeAll(() => createContextMenus());
    } else {
      createContextMenus();
    }
    chromeApi.contextMenus.onClicked?.addListener((info, tab) => {
      if (typeof tab?.id !== 'number') return;
      if (info.menuItemId === translateImageMenuId) {
        sendTabMessage(tab.id, { type: 'mt:context-menu-translate' });
      } else if (info.menuItemId === translateScreenshotMenuId) {
        sendTabMessage(tab.id, { type: 'mt:start-screenshot-translate' });
      }
    });
  }

  chromeApi?.commands?.onCommand?.addListener((command, tab) => {
    if (typeof tab?.id !== 'number') return;
    if (command === startScreenshotTranslateCommand) {
      sendTabMessage(tab.id, { type: 'mt:start-screenshot-translate' });
      return;
    }
    if (command === translateHoverTargetCommand) {
      sendTabMessage(tab.id, { type: 'mt:shortcut-translate-hover' });
    }
  });
}
