import type {
  AuthenticationTabLifecycle,
  ExtensionInstallationLifecycle,
  NativeCommands,
  NativeMenus,
  TabMessageTransport,
  VisibleTabCapture,
} from './contracts';
import {
  ExtensionContractError,
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
} from './errors';
import {
  assertJsonValue,
  idempotentCancel,
  isObject,
  operationFailure,
  requireFunction,
  requireNamespace,
} from './adapterInternal';
import {
  firefoxPromise,
  isUnavailableFirefoxMessageError,
  type FirefoxCommands,
  type FirefoxMenus,
  type FirefoxRuntime,
  type FirefoxTabs,
} from './firefoxInternal';

export function firefoxExtensionInstallation(
  runtime: FirefoxRuntime,
): ExtensionInstallationLifecycle {
  if (!isObject(runtime.onInstalled)) {
    throw new ExtensionContractError({
      capability: 'extension-installation',
      operation: 'onInstalled',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'runtime.onInstalled',
      },
    });
  }
  requireFunction(
    runtime.onInstalled.addListener,
    'extension-installation',
    'onInstalled',
  );
  requireFunction(
    runtime.onInstalled.removeListener,
    'extension-installation',
    'cancel:onInstalled',
  );
  return {
    onInstalled(listener) {
      const rawListener = (details: {
        reason?: string;
        previousVersion?: string;
      }): void => {
        const reason = details.reason === 'install'
          ? 'installed'
          : details.reason === 'update'
            ? 'upgraded'
            : 'other';
        listener({
          reason,
          ...(details.previousVersion
            ? { previousVersion: details.previousVersion }
            : {}),
        });
      };
      runtime.onInstalled.addListener(rawListener);
      return idempotentCancel(() => {
        runtime.onInstalled.removeListener(rawListener);
      });
    },
  };
}

export function firefoxAuthenticationTabs(
  rawTabs: FirefoxTabs | undefined,
): AuthenticationTabLifecycle {
  const tabs = requireNamespace(rawTabs, 'authentication-tabs', 'tabs');
  requireFunction(tabs.create, 'authentication-tabs', 'open');
  requireFunction(tabs.remove, 'authentication-tabs', 'close');
  for (const [operation, event] of [
    ['onNavigation', tabs.onUpdated],
    ['onClosed', tabs.onRemoved],
  ] as const) {
    if (!isObject(event)) {
      throw new ExtensionContractError({
        capability: 'authentication-tabs',
        operation,
        code: 'context-unavailable',
        retryable: false,
        diagnostic: {
          missing: operation,
        },
      });
    }
    requireFunction(event.addListener, 'authentication-tabs', operation);
    requireFunction(event.removeListener, 'authentication-tabs', `cancel:${operation}`);
  }
  return {
    async open(url) {
      try {
        new URL(url);
      } catch (error) {
        throw new ExtensionOperationError({
          capability: 'authentication-tabs',
          operation: 'open',
          code: 'serialization-failed',
          retryable: false,
          diagnostic: sanitizedErrorDiagnostic(error),
          cause: error,
        });
      }
      const tab = await firefoxPromise(
        'authentication-tabs',
        'open',
        () => tabs.create({ url, active: true }),
      );
      return typeof tab.id === 'number'
        ? { status: 'opened', tabId: tab.id }
        : { status: 'unavailable' };
    },
    async close(tabId) {
      try {
        await tabs.remove(tabId);
        return { status: 'closed' };
      } catch (error) {
        if (isUnavailableFirefoxMessageError(error)) {
          return { status: 'unavailable' };
        }
        throw operationFailure('authentication-tabs', 'close', error);
      }
    },
    onNavigation(listener) {
      const rawListener = (
        tabId: number,
        change: { url?: string },
      ): void => {
        if (change.url) listener({ tabId, url: change.url });
      };
      tabs.onUpdated.addListener(rawListener);
      return idempotentCancel(() => tabs.onUpdated.removeListener(rawListener));
    },
    onClosed(listener) {
      const rawListener = (tabId: number): void => listener(tabId);
      tabs.onRemoved.addListener(rawListener);
      return idempotentCancel(() => tabs.onRemoved.removeListener(rawListener));
    },
  };
}

export function firefoxNativeCommands(
  rawCommands: FirefoxCommands | undefined,
): NativeCommands {
  const commands = requireNamespace(
    rawCommands,
    'native-commands',
    'commands',
  );
  requireFunction(commands.getAll, 'native-commands', 'bindings');
  requireFunction(
    commands.openShortcutSettings,
    'native-commands',
    'openSettings',
  );
  if (!isObject(commands.onCommand)) {
    throw new ExtensionContractError({
      capability: 'native-commands',
      operation: 'onTriggered',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'commands.onCommand',
      },
    });
  }
  requireFunction(commands.onCommand.addListener, 'native-commands', 'onTriggered');
  requireFunction(
    commands.onCommand.removeListener,
    'native-commands',
    'cancel:onTriggered',
  );
  return {
    async bindings() {
      const values = await firefoxPromise(
        'native-commands',
        'bindings',
        () => commands.getAll(),
      );
      return values.flatMap((value) => value.name
        ? [{
            command: value.name,
            ...(value.description ? { description: value.description } : {}),
            ...(value.shortcut ? { shortcut: value.shortcut } : {}),
          }]
        : []);
    },
    onTriggered(listener) {
      const rawListener = (
        command: string,
        tab?: { id?: number },
      ): void => {
        listener({
          command,
          ...(typeof tab?.id === 'number' ? { tabId: tab.id } : {}),
        });
      };
      commands.onCommand.addListener(rawListener);
      return idempotentCancel(() => {
        commands.onCommand.removeListener(rawListener);
      });
    },
    async openSettings() {
      await firefoxPromise(
        'native-commands',
        'openSettings',
        () => commands.openShortcutSettings(),
      );
    },
  };
}

export function firefoxTabMessageTransport(
  rawTabs: FirefoxTabs | undefined,
): TabMessageTransport {
  const tabs = requireNamespace(rawTabs, 'tab-message', 'tabs');
  requireFunction(tabs.sendMessage, 'tab-message', 'send');
  return {
    async send(target, message) {
      assertJsonValue(message, 'tab-message', 'send');
      let response: unknown;
      try {
        response = await tabs.sendMessage(
          target.tabId,
          message,
          target.documentId
            ? { documentId: target.documentId }
            : undefined,
        );
      } catch (error) {
        if (isUnavailableFirefoxMessageError(error)) {
          return { status: 'unavailable' };
        }
        throw operationFailure('tab-message', 'send', error);
      }
      if (response === undefined) return { status: 'no-response' };
      assertJsonValue(response, 'tab-message', 'receiveResponse');
      return {
        status: 'response',
        value: response,
      };
    },
  };
}

export function firefoxVisibleTabCapture(
  rawTabs: FirefoxTabs | undefined,
): VisibleTabCapture {
  return {
    async capturePng(windowId) {
      const tabs = requireNamespace(
        rawTabs,
        'visible-tab-capture',
        'tabs',
      );
      requireFunction(
        tabs.captureVisibleTab,
        'visible-tab-capture',
        'capturePng',
      );
      const dataUrl = await firefoxPromise(
        'visible-tab-capture',
        'capturePng',
        () => tabs.captureVisibleTab(windowId, { format: 'png' }),
      );
      return dataUrl
        ? { status: 'captured', dataUrl }
        : { status: 'unavailable' };
    },
  };
}

export function firefoxNativeMenus(
  rawMenus: FirefoxMenus | undefined,
  runtime: FirefoxRuntime,
): NativeMenus {
  const menus = requireNamespace(rawMenus, 'native-menus', 'menus');
  requireFunction(menus.removeAll, 'native-menus', 'replace');
  requireFunction(menus.create, 'native-menus', 'replace');
  if (!isObject(menus.onClicked)) {
    throw new ExtensionContractError({
      capability: 'native-menus',
      operation: 'onSelected',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'menus.onClicked',
      },
    });
  }
  requireFunction(menus.onClicked.addListener, 'native-menus', 'onSelected');
  requireFunction(
    menus.onClicked.removeListener,
    'native-menus',
    'cancel:onSelected',
  );
  return {
    async replace(items) {
      await firefoxPromise(
        'native-menus',
        'replace',
        () => menus.removeAll(),
      );
      for (const item of items) {
        try {
          await new Promise<void>((resolve, reject) => {
            try {
              menus.create({
                id: item.id,
                title: item.title,
                contexts: [...item.contexts],
              }, () => {
                if (runtime.lastError) {
                  reject(new Error(
                    runtime.lastError.message ?? 'Firefox rejected menu creation',
                  ));
                  return;
                }
                resolve();
              });
            } catch (error) {
              reject(error);
            }
          });
        } catch (error) {
          throw operationFailure('native-menus', 'replace', error);
        }
      }
    },
    onSelected(listener) {
      const rawListener = (
        info: { menuItemId?: string | number },
        tab?: { id?: number },
      ): void => {
        if (info.menuItemId === undefined) return;
        listener({
          menuId: String(info.menuItemId),
          ...(typeof tab?.id === 'number' ? { tabId: tab.id } : {}),
        });
      };
      menus.onClicked.addListener(rawListener);
      return idempotentCancel(() => menus.onClicked.removeListener(rawListener));
    },
  };
}
