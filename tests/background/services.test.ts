import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
} from '../../src/shared/config';
import { getSettings, setSettings } from '../../src/background/settings/settingsStore';
import {
  parseImageDataUrl,
} from '../../src/background/images/imageService';
import {
  openAiOAuthInstallationIdStorageKey,
  openAiOAuthLastErrorStorageKey,
  openAiOAuthPendingStorageKey,
  openAiOAuthStorageKey,
} from '../../src/background/openai/oauthService';
import {
  registerMenusAndCommands,
  startScreenshotTranslateCommand,
  translateHoverTargetCommand,
  translateImageMenuId,
  translateScreenshotMenuId,
} from '../../src/background/menus/registerMenus';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background stable identifiers', () => {
  it('preserves storage, menu, and command identifiers', () => {
    expect({
      openAiOAuthStorageKey,
      openAiOAuthPendingStorageKey,
      openAiOAuthLastErrorStorageKey,
      openAiOAuthInstallationIdStorageKey,
      translateImageMenuId,
      translateScreenshotMenuId,
      startScreenshotTranslateCommand,
      translateHoverTargetCommand,
    }).toEqual({
      openAiOAuthStorageKey: 'mangaTranslate.openaiOAuth',
      openAiOAuthPendingStorageKey: 'mangaTranslate.openaiOAuthPending',
      openAiOAuthLastErrorStorageKey: 'mangaTranslate.openaiOAuthLastError',
      openAiOAuthInstallationIdStorageKey: 'mangaTranslate.openaiOAuthInstallationId',
      translateImageMenuId: 'translate-image',
      translateScreenshotMenuId: 'translate-screenshot',
      startScreenshotTranslateCommand: 'start-screenshot-translate',
      translateHoverTargetCommand: 'translate-hover-target',
    });
  });

  it('registers menus and forwards menu/command actions with stable messages', async () => {
    const create = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    let onClicked: ((info: { menuItemId?: string | number }, tab?: { id?: number }) => void) | undefined;
    let onCommand: ((command: string, tab?: { id?: number }) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {},
      tabs: { sendMessage },
      contextMenus: {
        create,
        removeAll(callback?: () => void) {
          callback?.();
        },
        onClicked: {
          addListener(listener: typeof onClicked) {
            onClicked = listener;
          },
        },
      },
      commands: {
        onCommand: {
          addListener(listener: typeof onCommand) {
            onCommand = listener;
          },
        },
      },
    });

    registerMenusAndCommands();

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: translateImageMenuId }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: translateScreenshotMenuId }));

    onClicked?.({ menuItemId: translateImageMenuId }, { id: 7 });
    onClicked?.({ menuItemId: translateScreenshotMenuId }, { id: 8 });
    onCommand?.(startScreenshotTranslateCommand, { id: 9 });
    onCommand?.(translateHoverTargetCommand, { id: 10 });
    await Promise.resolve();

    expect(sendMessage.mock.calls).toEqual([
      [7, { type: 'mt:context-menu-translate' }],
      [8, { type: 'mt:start-screenshot-translate' }],
      [9, { type: 'mt:start-screenshot-translate' }],
      [10, { type: 'mt:shortcut-translate-hover' }],
    ]);
  });
});

describe('settings store', () => {
  it('normalizes reads and persists writes under the stable settings key', async () => {
    const storage: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get(keys: string, callback: (items: Record<string, unknown>) => void) {
            callback({ [keys]: storage[keys] });
          },
          set(items: Record<string, unknown>, callback: () => void) {
            Object.assign(storage, items);
            callback();
          },
        },
      },
    });

    await expect(getSettings()).resolves.toEqual(defaultExtensionSettings);
    const nextSettings = { ...defaultExtensionSettings, targetLang: 'zh-CHT' as const };
    await expect(setSettings(nextSettings)).resolves.toEqual(nextSettings);
    expect(storage[extensionSettingsStorageKey]).toEqual(nextSettings);
  });
});

describe('image service', () => {
  it('parses screenshot data URLs', () => {
    expect(parseImageDataUrl('data:image/png;base64,aW1hZ2U=')).toEqual({
      contentType: 'image/png',
      base64: 'aW1hZ2U=',
    });
    expect(() => parseImageDataUrl('https://example.com/image.png')).toThrow('截图数据格式无效');
  });
});
