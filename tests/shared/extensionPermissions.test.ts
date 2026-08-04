import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHENTICATION_INFO_PERMISSION,
  createExtensionPermissions,
  ExtensionPermissionError,
  GEMINI_COOKIE_PERMISSION,
} from '../../apps/extension/src/shared/extensionPermissions';
import type {
  ExtensionBrowserApi,
  ExtensionPermissionRequest,
} from '../../apps/extension/src/shared/extensionRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExtensionPermissions', () => {
  it('treats Firefox-only required data declarations as granted on Chromium', async () => {
    const observed: ExtensionPermissionRequest[] = [];
    const api = {
      runtime: {},
      permissions: {
        contains: (request: ExtensionPermissionRequest, callback?: (result: boolean) => void) => {
          observed.push(request);
          callback?.(false);
        },
      },
    } satisfies ExtensionBrowserApi;
    vi.stubGlobal('chrome', api);

    await expect(
      createExtensionPermissions(api).assertGranted(AUTHENTICATION_INFO_PERMISSION),
    ).resolves.toBeUndefined();
    expect(observed).toEqual([]);
  });

  it('checks the install-time authentication declaration on Firefox', async () => {
    const contains = vi.fn(async (_value: ExtensionPermissionRequest) => true);
    const api = {
      runtime: {},
      commands: { openShortcutSettings: async () => undefined },
      permissions: { contains },
    } satisfies ExtensionBrowserApi;
    vi.stubGlobal('browser', api);

    await createExtensionPermissions(api).assertGranted(AUTHENTICATION_INFO_PERMISSION);
    expect(contains).toHaveBeenCalledWith({ data_collection: ['authenticationInfo'] });
  });

  it('fails closed without requesting the install-time Cookie permission', async () => {
    const contains = vi.fn((
      _request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => callback?.(false));
    const request = vi.fn();
    const api = {
      runtime: {},
      permissions: {
        contains,
        request,
      },
    } satisfies ExtensionBrowserApi;
    vi.stubGlobal('chrome', api);

    await expect(createExtensionPermissions(api).assertGranted(
      GEMINI_COOKIE_PERMISSION,
    )).rejects.toBeInstanceOf(
      ExtensionPermissionError,
    );
    expect(contains).toHaveBeenCalledWith(
      { permissions: ['cookies'], origins: undefined },
      expect.any(Function),
    );
    expect(request).not.toHaveBeenCalled();
  });
});
