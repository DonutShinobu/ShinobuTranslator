import type {
  BackgroundExtensionCapabilities,
  ContentExtensionCapabilities,
  ExtensionCapabilityAdapter,
  PopupExtensionCapabilities,
} from './contracts';
import { chromeApi, type ChromeApi } from './chromeInternal';
import {
  authenticationTabs,
  extensionInstallation,
  nativeCommands,
  nativeMenus,
  tabMessageTransport,
  visibleTabCapture,
} from './chromeInteraction';
import {
  referrerPolicyObserver,
  requestHeaderOverride,
} from './chromeNetwork';
import {
  extensionCookies,
  extensionPermissions,
} from './chromePermissions';
import {
  extensionEnvironment,
  runtimeChannelClient,
  runtimeChannelServer,
  runtimeRequestClient,
  runtimeRequestServer,
  runtimeRequestTransport,
} from './chromeRuntime';
import { extensionStorage } from './chromeStorage';

function createChromePopupCapabilities(
  chrome: ChromeApi,
): PopupExtensionCapabilities {
  return {
    runtimeRequests: runtimeRequestClient(chrome.runtime),
    persistentStorage: extensionStorage(
      chrome.runtime,
      chrome.storage?.local,
      'persistent',
    ),
    authenticationTabs: authenticationTabs(chrome.runtime, chrome.tabs),
    commands: nativeCommands(chrome.runtime, chrome.commands, chrome.tabs),
    permissions: extensionPermissions(chrome.runtime, chrome.permissions),
    environment: extensionEnvironment(chrome.runtime),
  };
}

function createChromeBackgroundCapabilities(
  chrome: ChromeApi,
): BackgroundExtensionCapabilities {
  const persistentStorage = extensionStorage(
    chrome.runtime,
    chrome.storage?.local,
    'persistent',
  );
  const sessionStorage = extensionStorage(
    chrome.runtime,
    chrome.storage?.session,
    'session',
  );
  const permissions = extensionPermissions(chrome.runtime, chrome.permissions);
  return {
    installation: extensionInstallation(chrome.runtime),
    runtimeRequests: runtimeRequestServer(chrome.runtime),
    runtimeChannels: runtimeChannelServer(chrome.runtime),
    persistentStorage,
    sessionStorage,
    tabMessages: tabMessageTransport(chrome.runtime, chrome.tabs),
    visibleTabCapture: visibleTabCapture(chrome.runtime, chrome.tabs),
    authenticationTabs: authenticationTabs(chrome.runtime, chrome.tabs),
    menus: nativeMenus(chrome.runtime, chrome.contextMenus),
    commands: nativeCommands(chrome.runtime, chrome.commands, chrome.tabs),
    permissions,
    cookies: extensionCookies(chrome.runtime, chrome.cookies, permissions),
    referrerPolicies: referrerPolicyObserver(
      chrome.webRequest?.onHeadersReceived,
    ),
    requestHeaderOverride: requestHeaderOverride(
      chrome.declarativeNetRequest,
      chrome.runtime.id,
    ),
    environment: extensionEnvironment(chrome.runtime),
  };
}

export function createChromeContentCapabilities(
  api: unknown,
): ContentExtensionCapabilities {
  const chrome = chromeApi(api);
  return {
    runtimeRequests: runtimeRequestTransport(chrome.runtime),
    runtimeChannels: runtimeChannelClient(chrome.runtime),
    environment: extensionEnvironment(chrome.runtime),
  };
}

export function createChromeExtensionAdapter(
  api: unknown,
): ExtensionCapabilityAdapter {
  const chrome = chromeApi(api);
  return {
    background() {
      return createChromeBackgroundCapabilities(chrome);
    },
    content() {
      return createChromeContentCapabilities(chrome);
    },
    popup() {
      return createChromePopupCapabilities(chrome);
    },
    pipelineHost() {
      return {
        runtimeRequests: runtimeRequestClient(chrome.runtime),
        runtimeChannels: runtimeChannelClient(chrome.runtime),
        environment: extensionEnvironment(chrome.runtime),
      };
    },
  };
}
