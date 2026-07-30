import { describe, expect, it } from 'vitest';
import {
  createChromeExtensionAdapter,
} from '../../../apps/extension/src/capabilities/chromeAdapter';
import type {
  JsonValue,
  PermissionChange,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionOperationError,
} from '../../../apps/extension/src/capabilities/errors';
import { createListenerEvent } from './listenerEvent.fixture';
import {
  runPopupCapabilityContract,
} from './extensionAdapterContract.fixture';

function createPopupHarness() {
  const localValues: Record<string, unknown> = {
    present: { nested: true },
  };
  const permissionAdded = createListenerEvent<Record<string, unknown>>();
  const permissionRemoved = createListenerEvent<Record<string, unknown>>();
  const commandListeners = new Set<
    (command: string, tab?: { id?: number }) => void
  >();
  const tabUpdatedListeners = new Set<
    (tabId: number, change: { url?: string }) => void
  >();
  const tabRemovedListeners = new Set<(tabId: number) => void>();
  let commandListenerRemovals = 0;
  let tabUpdatedListenerRemovals = 0;
  let tabRemovedListenerRemovals = 0;
  const openedUrls: string[] = [];
  const closedTabIds: number[] = [];
  let authenticationTabCloseUnavailable = false;
  const requestedPermissions: Array<Record<string, unknown>> = [];
  const grantedOrigins = new Set<string>();
  let cookieAccessGranted = false;
  let rejectStorage: Error | undefined;

  const runtime = {
    id: 'extension-id',
    lastError: undefined as { message?: string } | undefined,
    getManifest: () => ({ version: '0.8.1' }),
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
      callback(undefined);
    },
  };
  const completeStorage = (callback: () => void): void => {
    if (rejectStorage) {
      runtime.lastError = { message: rejectStorage.message };
      callback();
      runtime.lastError = undefined;
      rejectStorage = undefined;
      return;
    }
    callback();
  };
  const api = {
    runtime,
    storage: {
      local: {
        get(keys: string[], callback: (values: Record<string, unknown>) => void): void {
          completeStorage(() => {
            callback(Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(localValues, key))
                .map((key) => [key, localValues[key]]),
            ));
          });
        },
        set(values: Record<string, unknown>, callback: () => void): void {
          completeStorage(() => {
            Object.assign(localValues, values);
            callback();
          });
        },
        remove(keys: string[], callback: () => void): void {
          completeStorage(() => {
            for (const key of keys) delete localValues[key];
            callback();
          });
        },
      },
    },
    tabs: {
      create(
        details: { url?: string },
        callback: (tab: { id?: number }) => void,
      ): void {
        if (details.url) openedUrls.push(details.url);
        callback({ id: 17 });
      },
      remove(_tabId: number, callback: () => void): void {
        if (authenticationTabCloseUnavailable) {
          runtime.lastError = { message: `No tab with id: ${_tabId}.` };
          callback();
          runtime.lastError = undefined;
          authenticationTabCloseUnavailable = false;
          return;
        }
        closedTabIds.push(_tabId);
        callback();
      },
      onUpdated: {
        addListener(listener: (tabId: number, change: { url?: string }) => void): void {
          tabUpdatedListeners.add(listener);
        },
        removeListener(listener: (tabId: number, change: { url?: string }) => void): void {
          if (tabUpdatedListeners.delete(listener)) tabUpdatedListenerRemovals += 1;
        },
      },
      onRemoved: {
        addListener(listener: (tabId: number) => void): void {
          tabRemovedListeners.add(listener);
        },
        removeListener(listener: (tabId: number) => void): void {
          if (tabRemovedListeners.delete(listener)) tabRemovedListenerRemovals += 1;
        },
      },
    },
    commands: {
      getAll(callback: (commands: Array<Record<string, unknown>>) => void): void {
        callback([{
          name: 'translate-hover',
          description: 'Translate hovered image',
          shortcut: 'Alt+T',
        }]);
      },
      onCommand: {
        addListener(
          listener: (command: string, tab?: { id?: number }) => void,
        ): void {
          commandListeners.add(listener);
        },
        removeListener(
          listener: (command: string, tab?: { id?: number }) => void,
        ): void {
          if (commandListeners.delete(listener)) commandListenerRemovals += 1;
        },
      },
    },
    permissions: {
      contains(
        details: { permissions?: string[]; origins?: string[] },
        callback: (granted: boolean) => void,
      ): void {
        callback(
          (!details.permissions?.includes('cookies') || cookieAccessGranted)
          && (details.origins?.every((origin) => grantedOrigins.has(origin)) ?? true),
        );
      },
      request(
        details: Record<string, unknown>,
        callback: (granted: boolean) => void,
      ): void {
        requestedPermissions.push(details);
        callback(cookieAccessGranted);
      },
      onAdded: permissionAdded.raw,
      onRemoved: permissionRemoved.raw,
    },
  };

  const popup = createChromeExtensionAdapter(api).popup();
  return {
    popup,
    capabilities: popup,
    localValues,
    openedUrls,
    requestedPermissions,
    permissionRemoved,
    storedValue(key: string) {
      return localValues[key];
    },
    openedUrlValues() {
      return [...openedUrls];
    },
    expectedAuthenticationTabId() {
      return 17;
    },
    closedTabIds() {
      return [...closedTabIds];
    },
    makeNextAuthenticationTabCloseUnavailable() {
      authenticationTabCloseUnavailable = true;
    },
    emitAuthenticationNavigation(navigation: { tabId: number; url: string }) {
      for (const listener of tabUpdatedListeners) {
        listener(navigation.tabId, { url: navigation.url });
      }
    },
    emitAuthenticationClosed(tabId: number) {
      for (const listener of tabRemovedListeners) listener(tabId);
    },
    authenticationListenerRemovals() {
      return tabUpdatedListenerRemovals + tabRemovedListenerRemovals;
    },
    emitCommand(trigger: { command: string; tabId?: number }) {
      for (const listener of commandListeners) {
        listener(
          trigger.command,
          trigger.tabId === undefined ? undefined : { id: trigger.tabId },
        );
      }
    },
    commandListenerRemovals() {
      return commandListenerRemovals;
    },
    shortcutSettingsOpened() {
      return openedUrls.includes('chrome://extensions/shortcuts');
    },
    grantRequirement(requirement: {
      kind: 'authentication-data-use' | 'cookie-access' | 'target-origin';
      origin?: string;
    }) {
      if (requirement.kind === 'cookie-access') {
        cookieAccessGranted = true;
      } else if (requirement.kind === 'target-origin' && requirement.origin) {
        grantedOrigins.add(`${new URL(requirement.origin).origin}/*`);
      }
    },
    emitPermissionChange(change: PermissionChange) {
      const details = {
        permissions: change.requirements.some(
          (requirement) => requirement.kind === 'cookie-access',
        )
          ? ['cookies']
          : [],
        origins: change.requirements.flatMap((requirement) => requirement.kind
          === 'target-origin'
          ? [`${new URL(requirement.origin).origin}/*`]
          : []),
      };
      (change.status === 'granted' ? permissionAdded : permissionRemoved).emit(details);
    },
    permissionListenerRemovals() {
      return permissionAdded.removals() + permissionRemoved.removals();
    },
    expectedResourceUrl(path: string) {
      return `chrome-extension://extension-id/${path}`;
    },
    grantCookieAccess() {
      cookieAccessGranted = true;
    },
    grantOrigin(origin: string) {
      grantedOrigins.add(origin);
    },
    rejectNextStorage(error: Error) {
      rejectStorage = error;
    },
  };
}

describe('Chrome popup capability adapter', () => {
  runPopupCapabilityContract(createPopupHarness);

  it('reads missing storage keys as undefined and supports JSON writes/removes', async () => {
    const harness = createPopupHarness();

    await expect(harness.popup.persistentStorage.read([
      'present',
      'missing',
    ])).resolves.toEqual({
      present: { nested: true },
      missing: undefined,
    });

    await harness.popup.persistentStorage.write({
      language: 'zh-CN',
      flags: [true, false],
    });
    expect(harness.localValues.language).toBe('zh-CN');
    await harness.popup.persistentStorage.remove(['language']);
    expect(harness.localValues).not.toHaveProperty('language');
  });

  it('rejects non-JSON storage writes before calling Chrome', async () => {
    const invalidValues: unknown[] = [
      { callback: () => undefined },
      new Date('2026-01-01T00:00:00.000Z'),
      new Map([['key', 'value']]),
      Object.assign(Object.create({ inherited: true }), { own: true }),
      Array(1),
    ];

    for (const invalid of invalidValues) {
      const harness = createPopupHarness();
      await expect(harness.popup.persistentStorage.write({
        invalid: invalid as JsonValue,
      })).rejects.toMatchObject({
        code: 'serialization-failed',
        retryable: false,
      });
      expect(harness.localValues).not.toHaveProperty('invalid');
    }
  });

  it('normalizes storage rejection without leaking the browser message', async () => {
    const harness = createPopupHarness();
    harness.rejectNextStorage(new Error('api-key=top-secret'));

    const read = harness.popup.persistentStorage.read(['present']);

    await expect(read).rejects.toBeInstanceOf(ExtensionOperationError);
    await expect(read).rejects.toMatchObject({
      capability: 'persistent-storage',
      operation: 'read',
      code: 'browser-rejected',
      diagnostic: {
        errorName: 'Error',
      },
    });
    await expect(read).rejects.not.toThrow('top-secret');
  });

  it('returns semantic permission decisions and hides Chrome permission fields', async () => {
    const harness = createPopupHarness();
    const requirements = [
      { kind: 'authentication-data-use' as const },
      { kind: 'cookie-access' as const },
    ];

    await expect(harness.popup.permissions.check(requirements)).resolves.toEqual({
      status: 'not-granted',
      missing: [{ kind: 'cookie-access' }],
    });
    await expect(harness.popup.permissions.request(requirements)).resolves.toEqual({
      status: 'denied',
      missing: [{ kind: 'cookie-access' }],
    });

    harness.grantCookieAccess();
    await expect(harness.popup.permissions.request([
      {
        kind: 'target-origin',
        origin: 'https://api.example.test/v1',
      },
    ])).resolves.toEqual({ status: 'granted' });
    expect(harness.requestedPermissions.at(-1)).toEqual({
      origins: ['https://api.example.test/*'],
    });
  });

  it('reports only the requirements that are actually missing', async () => {
    const harness = createPopupHarness();
    harness.grantCookieAccess();

    await expect(harness.popup.permissions.check([
      { kind: 'cookie-access' },
      {
        kind: 'target-origin',
        origin: 'https://api.example.test/v1',
      },
    ])).resolves.toEqual({
      status: 'not-granted',
      missing: [{
        kind: 'target-origin',
        origin: 'https://api.example.test/v1',
      }],
    });

    harness.grantOrigin('https://api.example.test/*');
    await expect(harness.popup.permissions.check([
      { kind: 'cookie-access' },
      {
        kind: 'target-origin',
        origin: 'https://api.example.test/v1',
      },
    ])).resolves.toEqual({ status: 'granted' });
  });

  it('returns an idempotent cancellation function for permission changes', async () => {
    const harness = createPopupHarness();
    const changes: PermissionChange[] = [];
    const cancel = harness.popup.permissions.onChanged(
      [{ kind: 'cookie-access' }],
      (change) => changes.push(change),
    );

    harness.permissionRemoved.emit({ permissions: ['tabs'] });
    expect(changes).toEqual([]);
    harness.permissionRemoved.emit({ permissions: ['cookies'] });
    expect(changes).toEqual([{
      status: 'revoked',
      requirements: [{ kind: 'cookie-access' }],
    }]);

    cancel();
    cancel();
    expect(harness.permissionRemoved.removals()).toBe(1);
  });

  it('exposes shortcut behavior without native command or tab objects', async () => {
    const harness = createPopupHarness();

    await expect(harness.popup.commands.bindings()).resolves.toEqual([{
      command: 'translate-hover',
      description: 'Translate hovered image',
      shortcut: 'Alt+T',
    }]);
    await harness.popup.commands.openSettings();
    expect(harness.openedUrls).toContain('chrome://extensions/shortcuts');
  });
});
