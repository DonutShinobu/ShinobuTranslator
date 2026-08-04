import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionControlStateStorageKey,
  extensionInterfacePreferencesStorageKey,
  extensionProviderCredentialsStorageKey,
  extensionSettingsRevisionStorageKey,
  extensionTranslationDefaultsStorageKey,
  defaultExtensionSettings,
  extensionSettingsStorageKey,
} from '../../apps/extension/src/shared/config';
import {
  getSettings,
  getSettingsState,
  setSettings,
  setSettingsState,
} from '../../apps/extension/src/background/settings/settingsStore';
import {
  parseImageDataUrl,
} from '../../apps/extension/src/background/images/imageService';
import {
  openAiOAuthInstallationIdStorageKey,
  openAiOAuthLastErrorStorageKey,
  openAiOAuthPendingStorageKey,
  openAiOAuthStorageKey,
} from '../../apps/extension/src/background/openai/oauthService';
import {
  registerMenusAndCommands,
  startScreenshotTranslateCommand,
  translateHoverTargetCommand,
  translateImageMenuId,
  translateScreenshotMenuId,
} from '../../apps/extension/src/background/menus/registerMenus';

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
    let onInstalled: (() => void) | undefined;
    let onClicked: ((info: { menuItemId?: string | number }, tab?: { id?: number }) => void) | undefined;
    let onCommand: ((command: string, tab?: { id?: number }) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: {
          addListener(listener: typeof onInstalled) {
            onInstalled = listener;
          },
        },
      },
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

    expect(create).not.toHaveBeenCalled();
    onInstalled?.();
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
  it('migrates legacy settings into one atomic control record with separate sections', async () => {
    const legacySettings = {
      ...defaultExtensionSettings,
      targetLang: 'zh-CHT' as const,
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'secret-key',
        },
      },
    };
    const storage: Record<string, unknown> = {
      [extensionSettingsStorageKey]: legacySettings,
    };
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
          remove(keys: string | string[], callback: () => void) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
            callback();
          },
        },
      },
    });

    await expect(getSettings()).resolves.toEqual(legacySettings);
    expect(storage[extensionSettingsStorageKey]).toBeUndefined();
    const controlHead = storage[extensionControlStateStorageKey] as {
      schemaVersion: number;
      revision: number;
      generation: string;
    };
    expect(controlHead).toMatchObject({ schemaVersion: 1, revision: 0 });
    const translation = storage[`${extensionTranslationDefaultsStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, unknown>;
    };
    const credentials = storage[`${extensionProviderCredentialsStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, string>;
    };
    const preferences = storage[`${extensionInterfacePreferencesStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, unknown>;
    };
    expect(translation.schemaVersion).toBe(1);
    expect(JSON.stringify(translation.value)).not.toContain('secret-key');
    expect(credentials).toEqual({ schemaVersion: 1, value: { deepseek: 'secret-key' } });
    expect(preferences.value).toMatchObject({
      showElapsedTime: false,
      stageTimingCardExpanded: true,
    });
    expect(storage[extensionTranslationDefaultsStorageKey]).toBeUndefined();
    expect(storage[extensionProviderCredentialsStorageKey]).toBeUndefined();
    expect(storage[extensionInterfacePreferencesStorageKey]).toBeUndefined();
    expect(storage[extensionSettingsRevisionStorageKey]).toBeUndefined();

    const nextSettings = { ...defaultExtensionSettings, targetLang: 'zh-CHT' as const };
    await expect(setSettings(nextSettings)).resolves.toEqual(nextSettings);
    const nextHead = storage[extensionControlStateStorageKey] as typeof controlHead;
    expect(nextHead).toMatchObject({ revision: 0 });
    expect(storage[`${extensionTranslationDefaultsStorageKey}.${nextHead.generation}`]).toMatchObject({
      schemaVersion: 1,
      value: { targetLang: 'zh-CHT' },
    });

    await setSettingsState({ settings: nextSettings, revision: 9 });
    await expect(getSettingsState()).resolves.toEqual({ settings: nextSettings, revision: 9 });
    expect(storage[extensionControlStateStorageKey]).toMatchObject({ revision: 9 });
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
