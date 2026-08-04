import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSettingsState,
  setSettingsState,
} from '../../apps/extension/src/background/settings/settingsStore';
import {
  extensionControlStateStorageKey,
  extensionInterfacePreferencesStorageKey,
} from '../../apps/extension/src/shared/config';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('settings store atomic commit', () => {
  it('keeps the previous generation visible when a section write fails', async () => {
    const storage: Record<string, unknown> = {};
    const runtime: { lastError?: { message: string } } = {};
    let failPreferenceWrite = false;
    vi.stubGlobal('chrome', {
      runtime,
      storage: {
        local: {
          get(keys: string[], callback: (items: Record<string, unknown>) => void) {
            const key = keys[0]!;
            callback({ [key]: storage[key] });
          },
          set(items: Record<string, unknown>, callback: () => void) {
            const key = Object.keys(items)[0]!;
            if (failPreferenceWrite && key.startsWith(`${extensionInterfacePreferencesStorageKey}.`)) {
              runtime.lastError = { message: 'preference write failed' };
              callback();
              delete runtime.lastError;
              return;
            }
            Object.assign(storage, items);
            callback();
          },
          remove(keys: string[], callback: () => void) {
            for (const key of keys) delete storage[key];
            callback();
          },
        },
      },
    });

    const initial = await getSettingsState();
    const initialHead = storage[extensionControlStateStorageKey];
    failPreferenceWrite = true;

    await expect(setSettingsState({
      settings: { ...initial.settings, targetLang: 'zh-CHT' },
      revision: initial.revision + 1,
    })).rejects.toThrow('preference write failed');

    expect(storage[extensionControlStateStorageKey]).toEqual(initialHead);
    await expect(getSettingsState()).resolves.toMatchObject({
      revision: initial.revision,
      settings: { targetLang: initial.settings.targetLang },
    });
  });
});
