import { describe, expect, it } from 'vitest';
import {
  createFirefoxBasicBackgroundCapabilities,
  createFirefoxBasicPopupCapabilities,
} from '../../../apps/extension/src/capabilities/firefoxAdapter';
import {
  runBackgroundBasicCapabilityContract,
  runPopupBasicCapabilityContract,
} from './extensionAdapterContract.fixture';
import { createListenerEvent } from './listenerEvent.fixture';

function createFirefoxHarness() {
  const localValues: Record<string, unknown> = {
    present: { nested: true },
  };
  const sessionValues: Record<string, unknown> = {};
  let rejectedStorage: Error | undefined;
  let tabMessageFailure: 'unavailable' | 'rejected' | undefined;
  let captureResult: string | undefined;
  let rejectedMenuCreate: Error | undefined;
  let shortcutSettingsOpened = false;
  const commandListeners = createListenerEvent<[
    string,
    { id?: number } | undefined,
  ]>();
  const menuListeners = createListenerEvent<[
    { menuItemId?: string | number },
    { id?: number } | undefined,
  ]>();
  const installationListeners = createListenerEvent<{
    reason?: string;
    previousVersion?: string;
  }>();
  type CommandListener = (
    command: string,
    tab?: { id?: number },
  ) => void;
  const commandWrappers = new Map<
    CommandListener,
    (value: [string, { id?: number } | undefined]) => void
  >();
  type MenuListener = (
    info: { menuItemId?: string | number },
    tab?: { id?: number },
  ) => void;
  const menuWrappers = new Map<
    MenuListener,
    (value: [
      { menuItemId?: string | number },
      { id?: number } | undefined,
    ]) => void
  >();

  function storageArea(values: Record<string, unknown>) {
    const complete = (): void => {
      if (!rejectedStorage) return;
      const error = rejectedStorage;
      rejectedStorage = undefined;
      throw error;
    };
    return {
      async get(keys: string[]): Promise<Record<string, unknown>> {
        complete();
        return Object.fromEntries(
          keys
            .filter((key) => Object.hasOwn(values, key))
            .map((key) => [key, values[key]]),
        );
      },
      async set(next: Record<string, unknown>): Promise<void> {
        complete();
        Object.assign(values, next);
      },
      async remove(keys: string[]): Promise<void> {
        complete();
        for (const key of keys) delete values[key];
      },
    };
  }

  const runtime = {
    id: 'extension-id',
    lastError: undefined as { message?: string } | undefined,
    getManifest: () => ({ version: '0.8.1' }),
    getURL: (path: string) => `moz-extension://extension-id/${path}`,
    async sendMessage(): Promise<unknown> {
      return undefined;
    },
    connect() {
      return {
        name: 'unused',
        postMessage: () => undefined,
        disconnect: () => undefined,
        onMessage: createListenerEvent<unknown>().raw,
        onDisconnect: createListenerEvent<void>().raw,
      };
    },
    onMessage: createListenerEvent<
      (request: unknown, sender: unknown) => Promise<unknown> | undefined
    >().raw,
    onConnect: createListenerEvent<unknown>().raw,
    onInstalled: installationListeners.raw,
  };
  const api = {
    runtime,
    storage: {
      local: storageArea(localValues),
      session: storageArea(sessionValues),
    },
    tabs: {
      async sendMessage(
        _tabId: number,
        _message: unknown,
        _options?: { documentId: string },
      ): Promise<unknown> {
        if (tabMessageFailure) {
          const failure = tabMessageFailure;
          tabMessageFailure = undefined;
          throw new Error(
            failure === 'unavailable'
              ? 'Could not establish connection. Receiving end does not exist.'
              : 'api-key=top-secret',
          );
        }
        return { ok: true };
      },
      async captureVisibleTab(
        _windowId: number | undefined,
        _options: { format: 'png' },
      ): Promise<string | undefined> {
        return captureResult;
      },
      async create(): Promise<{ id?: number }> {
        return { id: 17 };
      },
      async remove(): Promise<void> {},
      onUpdated: createListenerEvent<[
        number,
        { url?: string },
        unknown?,
      ]>().raw,
      onRemoved: createListenerEvent<number>().raw,
    },
    commands: {
      async getAll(): Promise<Array<Record<string, unknown>>> {
        return [{
          name: 'translate-hover',
          description: 'Translate hovered image',
          shortcut: 'Alt+T',
        }];
      },
      async openShortcutSettings(): Promise<void> {
        shortcutSettingsOpened = true;
      },
      onCommand: {
        addListener(
          listener: CommandListener,
        ): void {
          const wrapper = ([command, tab]: [
            string,
            { id?: number } | undefined,
          ]): void => {
            listener(command, tab);
          };
          commandWrappers.set(listener, wrapper);
          commandListeners.raw.addListener(wrapper);
        },
        removeListener(
          listener: CommandListener,
        ): void {
          const wrapper = commandWrappers.get(listener);
          if (!wrapper) return;
          commandWrappers.delete(listener);
          commandListeners.raw.removeListener(wrapper);
        },
      },
    },
    menus: {
      async removeAll(): Promise<void> {},
      create(
        _item: unknown,
        complete?: () => void,
      ): string {
        if (rejectedMenuCreate) {
          runtime.lastError = { message: rejectedMenuCreate.message };
          rejectedMenuCreate = undefined;
          complete?.();
          runtime.lastError = undefined;
          return 'created';
        }
        complete?.();
        return 'created';
      },
      onClicked: {
        addListener(
          listener: MenuListener,
        ): void {
          const wrapper = ([info, tab]: [
            { menuItemId?: string | number },
            { id?: number } | undefined,
          ]): void => {
            listener(info, tab);
          };
          menuWrappers.set(listener, wrapper);
          menuListeners.raw.addListener(wrapper);
        },
        removeListener(
          listener: MenuListener,
        ): void {
          const wrapper = menuWrappers.get(listener);
          if (!wrapper) return;
          menuWrappers.delete(listener);
          menuListeners.raw.removeListener(wrapper);
        },
      },
    },
  };

  const popup = createFirefoxBasicPopupCapabilities(api);
  const background = createFirefoxBasicBackgroundCapabilities(api);
  return {
    popup,
    background,
    storedValue(key: string) {
      return localValues[key];
    },
    rejectNextStorage(error: Error) {
      rejectedStorage = error;
    },
    emitCommand(command: string, tabId?: number) {
      commandListeners.emit([
        command,
        tabId === undefined ? undefined : { id: tabId },
      ]);
    },
    commandListenerRemovals() {
      return commandListeners.removals();
    },
    shortcutSettingsOpened() {
      return shortcutSettingsOpened;
    },
    expectedResourceUrl(path: string) {
      return `moz-extension://extension-id/${path}`;
    },
    makeNextTabMessageUnavailable() {
      tabMessageFailure = 'unavailable';
    },
    rejectNextTabMessage() {
      tabMessageFailure = 'rejected';
    },
    rejectNextMenuCreate(error: Error) {
      rejectedMenuCreate = error;
    },
    setCaptureResult(value: string | undefined) {
      captureResult = value;
    },
    emitMenuSelection(menuId: string, tabId?: number) {
      menuListeners.emit([
        { menuItemId: menuId },
        tabId === undefined ? undefined : { id: tabId },
      ]);
    },
    menuListenerRemovals() {
      return menuListeners.removals();
    },
    emitInstallation(reason: 'install' | 'update' | 'browser_update') {
      installationListeners.emit({ reason });
    },
    installationListenerRemovals() {
      return installationListeners.removals();
    },
  };
}

describe('Firefox basic extension adapter contract', () => {
  runPopupBasicCapabilityContract(() => {
    const harness = createFirefoxHarness();
    return {
      capabilities: harness.popup,
      storedValue: harness.storedValue,
      rejectNextStorage: harness.rejectNextStorage,
      emitCommand(trigger) {
        harness.emitCommand(trigger.command, trigger.tabId);
      },
      commandListenerRemovals: harness.commandListenerRemovals,
      shortcutSettingsOpened: harness.shortcutSettingsOpened,
      expectedResourceUrl: harness.expectedResourceUrl,
    };
  });

  runBackgroundBasicCapabilityContract(() => {
    const harness = createFirefoxHarness();
    return {
      capabilities: harness.background,
      makeNextTabMessageUnavailable: harness.makeNextTabMessageUnavailable,
      rejectNextTabMessage: harness.rejectNextTabMessage,
      setCaptureResult: harness.setCaptureResult,
      emitMenuSelection: harness.emitMenuSelection,
      menuListenerRemovals: harness.menuListenerRemovals,
      emitInstallation: harness.emitInstallation,
      installationListenerRemovals: harness.installationListenerRemovals,
    };
  });

  it('maps Firefox menu creation rejection to the stable error contract', async () => {
    const harness = createFirefoxHarness();
    harness.rejectNextMenuCreate(new Error('menu title rejected'));

    await expect(harness.background.menus.replace([{
      id: 'translate-image',
      title: 'Translate image',
      contexts: ['image'],
    }])).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'native-menus',
      operation: 'replace',
      code: 'browser-rejected',
    });
  });
});
