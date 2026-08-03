import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getExtensionRuntime,
  type ExtensionBrowserApi,
} from '../../src/shared/extensionRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExtensionRuntime', () => {
  it('normalizes callback-style Chromium messages and runtime errors', async () => {
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getManifest: () => ({ version: '1.2.3' }),
        sendMessage: (_message: unknown, callback?: (value: unknown) => void) => {
          callback?.({ ok: true });
        },
      },
    };
    vi.stubGlobal('chrome', api);

    const runtime = getExtensionRuntime();
    await expect(runtime?.sendMessage({ type: 'ping' })).resolves.toEqual({ ok: true });
    expect(runtime?.getURL('worker.js')).toBe('chrome-extension://test/worker.js');
    expect(runtime?.getVersion()).toBe('1.2.3');
    expect(runtime?.keepsBackgroundAliveWithPort()).toBe(false);

    api.runtime!.lastError = { message: 'port closed' };
    await expect(runtime?.sendMessage({ type: 'ping' })).rejects.toThrow('port closed');
  });

  it('normalizes Firefox Promise APIs and uses its shortcut capability', async () => {
    const openShortcutSettings = vi.fn(async () => undefined);
    const createTab = vi.fn(async () => ({}));
    const api = {
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      commands: { openShortcutSettings },
      tabs: { create: createTab },
    } satisfies ExtensionBrowserApi;
    vi.stubGlobal('browser', api);

    const runtime = getExtensionRuntime();
    await expect(runtime?.sendMessage({ type: 'ping' })).resolves.toEqual({ ok: true });
    expect(runtime?.keepsBackgroundAliveWithPort()).toBe(true);
    await runtime?.openShortcutSettings();
    expect(openShortcutSettings).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('keeps the Chromium internal shortcut URL inside the adapter', async () => {
    const createTab = vi.fn((
      _properties: { url?: string; active?: boolean },
      callback?: (tab: { id?: number }) => void,
    ) => callback?.({ id: 1 }));
    const api = { runtime: {}, tabs: { create: createTab } } satisfies ExtensionBrowserApi;
    vi.stubGlobal('chrome', api);

    await getExtensionRuntime()?.openShortcutSettings();
    expect(createTab).toHaveBeenCalledWith(
      { url: 'chrome://extensions/shortcuts', active: true },
      expect.any(Function),
    );
  });
});
