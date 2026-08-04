import { describe, expect, it, vi } from 'vitest';
import { getSettingsState } from '../../apps/extension/src/background/settings/settingsStore';
import { extensionControlStateStorageKey } from '../../apps/extension/src/shared/config';

describe('settings store initialization recovery', () => {
  it('retries after a transient storage initialization failure', async () => {
    const storage: Record<string, unknown> = {};
    const runtime: { lastError?: { message: string } } = {};
    let setAttempts = 0;
    vi.stubGlobal('chrome', {
      runtime,
      storage: {
        local: {
          get(keys: string[], callback: (items: Record<string, unknown>) => void) {
            const key = keys[0]!;
            callback({ [key]: storage[key] });
          },
          set(items: Record<string, unknown>, callback: () => void) {
            setAttempts += 1;
            if (setAttempts === 1) {
              runtime.lastError = { message: 'temporary storage failure' };
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

    await expect(getSettingsState()).rejects.toThrow('temporary storage failure');
    await expect(getSettingsState()).resolves.toMatchObject({ revision: 0 });
    expect(storage[extensionControlStateStorageKey]).toMatchObject({
      schemaVersion: 1,
      generation: expect.any(String),
    });
  });
});
