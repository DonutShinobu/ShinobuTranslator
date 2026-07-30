import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
} from '../../src/shared/config';
import { createSettingsStore } from '../../src/background/settings/settingsStore';
import type {
  ExtensionStorage,
  JsonValue,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  AuthenticationAccess,
} from '../../apps/extension/src/capabilities/authentication';
import {
  captureVisibleTab,
  parseImageDataUrl,
} from '../../src/background/images/imageService';
import {
  loginGeminiApp,
  openGeminiAppAuthTab,
} from '../../src/background/gemini/authService';
import {
  createOpenAiOAuthService,
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

const grantedAuthentication: AuthenticationAccess = {
  check: async () => ({ status: 'granted' }),
  request: async () => ({ status: 'granted' }),
  require: async () => ({ status: 'granted' }),
  onChanged: () => () => undefined,
  readGeminiCookies: async () => ({
    status: 'available',
    cookies: [],
  }),
};

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
    const replace = vi.fn(async () => {});
    const send = vi.fn(async (target: { tabId: number }) => (
      target.tabId === 8
        ? { status: 'unavailable' as const }
        : { status: 'no-response' as const }
    ));
    let installed: ((change: { reason: 'installed' | 'upgraded' | 'other' }) => void) | undefined;
    let selected: ((selection: { menuId: string; tabId?: number }) => void) | undefined;
    let triggered: ((trigger: { command: string; tabId?: number }) => void) | undefined;

    registerMenusAndCommands({
      installation: {
        onInstalled(listener) {
          installed = listener;
          return () => {};
        },
      },
      menus: {
        replace,
        onSelected(listener) {
          selected = listener;
          return () => {};
        },
      },
      commands: {
        async bindings() {
          return [];
        },
        onTriggered(listener) {
          triggered = listener;
          return () => {};
        },
        async openSettings() {},
      },
      tabMessages: { send },
    });

    expect(selected).toBeTypeOf('function');
    expect(triggered).toBeTypeOf('function');
    expect(replace).not.toHaveBeenCalled();

    installed?.({ reason: 'other' });
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    installed?.({ reason: 'installed' });
    await Promise.resolve();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith([
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
    ]);
    installed?.({ reason: 'upgraded' });
    await Promise.resolve();
    expect(replace).toHaveBeenCalledTimes(2);

    selected?.({ menuId: translateImageMenuId, tabId: 7 });
    selected?.({ menuId: translateScreenshotMenuId, tabId: 8 });
    triggered?.({ command: startScreenshotTranslateCommand, tabId: 9 });
    triggered?.({ command: translateHoverTargetCommand, tabId: 10 });
    await Promise.resolve();

    expect(send.mock.calls).toEqual([
      [{ tabId: 7 }, { type: 'mt:context-menu-translate' }],
      [{ tabId: 8 }, { type: 'mt:start-screenshot-translate' }],
      [{ tabId: 9 }, { type: 'mt:start-screenshot-translate' }],
      [{ tabId: 10 }, { type: 'mt:shortcut-translate-hover' }],
    ]);
  });
});

describe('settings store', () => {
  it('normalizes reads and persists writes under the stable settings key', async () => {
    const values: Record<string, JsonValue> = {};
    const storage: ExtensionStorage = {
      async read(keys) {
        return Object.fromEntries(
          keys.map((key) => [key, values[key]]),
        );
      },
      async write(next) {
        Object.assign(values, next);
      },
      async remove(keys) {
        for (const key of keys) delete values[key];
      },
    };
    const settings = createSettingsStore(storage);

    await expect(settings.get()).resolves.toEqual(defaultExtensionSettings);
    const nextSettings = { ...defaultExtensionSettings, targetLang: 'zh-CHT' as const };
    await expect(settings.set(nextSettings)).resolves.toEqual(nextSettings);
    expect(values[extensionSettingsStorageKey]).toEqual(nextSettings);
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

  it('captures a visible tab as PNG through the capability result', async () => {
    const capturePng = vi.fn(async () => ({
      status: 'captured' as const,
      dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
    }));

    await expect(captureVisibleTab(
      { capturePng },
      {
        windowId: 3,
        sourceUrl: 'https://example.com/chapter',
      },
    )).resolves.toEqual({
      base64: 'c2NyZWVuc2hvdA==',
      contentType: 'image/png',
      sourceUrl: 'https://example.com/chapter',
    });
    expect(capturePng).toHaveBeenCalledWith(3);
  });
});

describe('authentication tabs', () => {
  it('opens Gemini login through the authentication-tab capability', async () => {
    const authenticationTabs = {
      open: vi.fn(async () => ({ status: 'opened' as const, tabId: 31 })),
      close: vi.fn(async () => ({ status: 'closed' as const })),
      onNavigation: vi.fn(() => () => {}),
      onClosed: vi.fn(() => () => {}),
    };

    await expect(openGeminiAppAuthTab(authenticationTabs)).resolves.toBeUndefined();
    await expect(loginGeminiApp(
      defaultExtensionSettings,
      grantedAuthentication,
      authenticationTabs,
    ))
      .resolves.toEqual({ authenticated: false, pending: true });
    expect(authenticationTabs.open).toHaveBeenCalledTimes(2);
  });

  it('uses structured tab lifecycle results for OpenAI login and close', async () => {
    const values: Record<string, JsonValue> = {};
    const storage: ExtensionStorage = {
      async read(keys) {
        return Object.fromEntries(keys.map((key) => [key, values[key]]));
      },
      async write(next) {
        Object.assign(values, next);
      },
      async remove(keys) {
        for (const key of keys) delete values[key];
      },
    };
    const authenticationTabs = {
      open: vi.fn(async () => ({ status: 'opened' as const, tabId: 41 })),
      close: vi.fn(async () => ({ status: 'unavailable' as const })),
      onNavigation: vi.fn(() => () => {}),
      onClosed: vi.fn(() => () => {}),
    };
    const openAiOAuth = createOpenAiOAuthService({
      storage,
      authenticationTabs,
      authentication: grantedAuthentication,
    });

    await expect(openAiOAuth.login()).resolves.toEqual({
      authenticated: false,
      pending: true,
    });
    await openAiOAuth.handleTabRemoved(41);
    await expect(openAiOAuth.status()).resolves.toMatchObject({
      authenticated: false,
      pending: false,
      error: 'OpenAI 登录窗口已关闭，请重新登录',
    });

    await openAiOAuth.login();
    await expect(openAiOAuth.logout()).resolves.toEqual({
      authenticated: false,
    });
    expect(authenticationTabs.close).toHaveBeenCalledWith(41);
  });
});
