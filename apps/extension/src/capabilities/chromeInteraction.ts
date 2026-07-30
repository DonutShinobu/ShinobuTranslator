import type {
  AuthenticationTabCloseResult,
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
  chromeCallback,
  idempotentCancel,
  isUnavailableMessageError,
  isObject,
  requireFunction,
  requireNamespace,
  type ChromeCommands,
  type ChromeContextMenus,
  type ChromeRuntime,
  type ChromeTabs,
} from './chromeInternal';

export function extensionInstallation(
  runtime: ChromeRuntime,
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

export function authenticationTabs(
  runtime: ChromeRuntime,
  rawTabs: ChromeTabs | undefined,
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
      const tab = await chromeCallback<{ id?: number }>(
        runtime,
        'authentication-tabs',
        'open',
        (complete) => tabs.create({ url, active: true }, complete),
      );
      return typeof tab.id === 'number'
        ? { status: 'opened', tabId: tab.id }
        : { status: 'unavailable' };
    },
    async close(tabId) {
      return await chromeCallback<AuthenticationTabCloseResult>(
        runtime,
        'authentication-tabs',
        'close',
        (complete) => tabs.remove(
          tabId,
          () => complete({ status: 'closed' }),
        ),
        (error) => isUnavailableMessageError(error)
          ? { handled: true, value: { status: 'unavailable' } }
          : { handled: false },
      );
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

export function nativeCommands(
  runtime: ChromeRuntime,
  rawCommands: ChromeCommands | undefined,
  rawTabs: ChromeTabs | undefined,
): NativeCommands {
  const commands = requireNamespace(rawCommands, 'native-commands', 'commands');
  const tabs = requireNamespace(rawTabs, 'native-commands', 'tabs');
  requireFunction(commands.getAll, 'native-commands', 'bindings');
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
  requireFunction(tabs.create, 'native-commands', 'openSettings');
  return {
    async bindings() {
      const values = await chromeCallback<
        Array<{
          name?: string;
          description?: string;
          shortcut?: string;
        }>
      >(runtime, 'native-commands', 'bindings', (complete) => {
        commands.getAll(complete);
      });
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
      await chromeCallback<{ id?: number }>(
        runtime,
        'native-commands',
        'openSettings',
        (complete) => tabs.create({
          url: 'chrome://extensions/shortcuts',
          active: true,
        }, complete),
      );
    },
  };
}

export function tabMessageTransport(
  runtime: ChromeRuntime,
  rawTabs: ChromeTabs | undefined,
): TabMessageTransport {
  const tabs = requireNamespace(rawTabs, 'tab-message', 'tabs');
  requireFunction(tabs.sendMessage, 'tab-message', 'send');
  return {
    async send(target, message) {
      assertJsonValue(message, 'tab-message', 'send');
      const response = await chromeCallback<
        { status: 'received'; value: unknown } | { status: 'unavailable' }
      >(
        runtime,
        'tab-message',
        'send',
        (complete) => {
          const receive = (value: unknown): void => {
            complete({ status: 'received', value });
          };
          if (target.documentId) {
            tabs.sendMessage(
              target.tabId,
              message,
              { documentId: target.documentId },
              receive,
            );
          } else {
            tabs.sendMessage(target.tabId, message, receive);
          }
        },
        (error) => isUnavailableMessageError(error)
          ? { handled: true, value: { status: 'unavailable' } }
          : { handled: false },
      );
      if (response.status === 'unavailable') return response;
      const value = response.value;
      if (value === undefined) return { status: 'no-response' };
      assertJsonValue(value, 'tab-message', 'receiveResponse');
      return {
        status: 'response',
        value,
      };
    },
  };
}

export function visibleTabCapture(
  runtime: ChromeRuntime,
  rawTabs: ChromeTabs | undefined,
): VisibleTabCapture {
  const tabs = requireNamespace(rawTabs, 'visible-tab-capture', 'tabs');
  requireFunction(tabs.captureVisibleTab, 'visible-tab-capture', 'capturePng');
  return {
    async capturePng(windowId) {
      const dataUrl = await chromeCallback<string | undefined>(
        runtime,
        'visible-tab-capture',
        'capturePng',
        (complete) => tabs.captureVisibleTab(
          windowId,
          { format: 'png' },
          complete,
        ),
      );
      return dataUrl
        ? { status: 'captured', dataUrl }
        : { status: 'unavailable' };
    },
  };
}

export function nativeMenus(
  runtime: ChromeRuntime,
  rawMenus: ChromeContextMenus | undefined,
): NativeMenus {
  const menus = requireNamespace(rawMenus, 'native-menus', 'contextMenus');
  requireFunction(menus.removeAll, 'native-menus', 'replace');
  requireFunction(menus.create, 'native-menus', 'replace');
  if (!isObject(menus.onClicked)) {
    throw new ExtensionContractError({
      capability: 'native-menus',
      operation: 'onSelected',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'contextMenus.onClicked',
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
      await chromeCallback<void>(
        runtime,
        'native-menus',
        'replace',
        (complete) => menus.removeAll(() => complete(undefined)),
      );
      for (const item of items) {
        await chromeCallback<void>(
          runtime,
          'native-menus',
          'replace',
          (complete) => menus.create({
            id: item.id,
            title: item.title,
            contexts: [...item.contexts],
          }, () => complete(undefined)),
        );
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
