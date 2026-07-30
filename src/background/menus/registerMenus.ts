import type {
  BackgroundExtensionCapabilities,
  NativeMenuDeclaration,
} from '../../../apps/extension/src/capabilities/contracts';
import type { RuntimeMessage } from '../../shared/messages';

export const translateImageMenuId = 'translate-image';
export const translateScreenshotMenuId = 'translate-screenshot';
export const startScreenshotTranslateCommand = 'start-screenshot-translate';
export const translateHoverTargetCommand = 'translate-hover-target';

const menuDeclarations: readonly NativeMenuDeclaration[] = [
  {
    id: translateImageMenuId,
    title: '翻译图片',
    contexts: ['all'],
  },
  {
    id: translateScreenshotMenuId,
    title: '截图翻译',
    contexts: ['all'],
  },
];

type NativeInteractionCapabilities = Pick<
  BackgroundExtensionCapabilities,
  'installation' | 'menus' | 'commands' | 'tabMessages'
>;

type NativeInteractionMessage = Extract<
  RuntimeMessage,
  {
    type:
      | 'mt:context-menu-translate'
      | 'mt:start-screenshot-translate'
      | 'mt:shortcut-translate-hover';
  }
>;

function sendTabMessage(
  capabilities: NativeInteractionCapabilities,
  tabId: number | undefined,
  message: NativeInteractionMessage,
): void {
  if (tabId === undefined) return;
  void capabilities.tabMessages.send({ tabId }, message).catch(() => {
    // Native interactions have no response surface. Structured operation errors
    // are intentionally contained while an unavailable receiver is a normal result.
  });
}

export function registerMenusAndCommands(
  capabilities: NativeInteractionCapabilities,
): void {
  capabilities.installation.onInstalled(
    ({ reason }) => {
      if (reason !== 'installed' && reason !== 'upgraded') return;
      void capabilities.menus.replace(menuDeclarations).catch(() => {
        // Menu installation is retried by the next install or upgrade event.
      });
    },
  );
  capabilities.menus.onSelected(({ menuId, tabId }) => {
    if (menuId === translateImageMenuId) {
      sendTabMessage(capabilities, tabId, {
        type: 'mt:context-menu-translate',
      });
    } else if (menuId === translateScreenshotMenuId) {
      sendTabMessage(capabilities, tabId, {
        type: 'mt:start-screenshot-translate',
      });
    }
  });
  capabilities.commands.onTriggered(({
    command,
    tabId,
  }) => {
    if (command === startScreenshotTranslateCommand) {
      sendTabMessage(capabilities, tabId, {
        type: 'mt:start-screenshot-translate',
      });
    } else if (command === translateHoverTargetCommand) {
      sendTabMessage(capabilities, tabId, {
        type: 'mt:shortcut-translate-hover',
      });
    }
  });

}
