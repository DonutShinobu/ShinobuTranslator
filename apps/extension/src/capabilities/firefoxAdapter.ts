import type {
  BackgroundExtensionCapabilities,
  ContentExtensionCapabilities,
  ExtensionCapabilityAdapter,
  PopupExtensionCapabilities,
} from './contracts';
import type {
  ExtensionCompatibilityCapabilities,
} from './compatibility';
import {
  firefoxApi,
} from './firefoxInternal';
import {
  firefoxExtensionInstallation,
  firefoxAuthenticationTabs,
  firefoxNativeCommands,
  firefoxNativeMenus,
  firefoxTabMessageTransport,
  firefoxVisibleTabCapture,
} from './firefoxInteraction';
import {
  firefoxExtensionEnvironment,
  firefoxRuntimeChannelClient,
  firefoxRuntimeChannelServer,
  firefoxRuntimeRequestClient,
  firefoxRuntimeRequestServer,
  firefoxRuntimeRequestTransport,
} from './firefoxRuntime';
import {
  firefoxExtensionStorage,
} from './firefoxStorage';

export type FirefoxBasicBackgroundCapabilities = Pick<
  BackgroundExtensionCapabilities,
  | 'installation'
  | 'persistentStorage'
  | 'sessionStorage'
  | 'tabMessages'
  | 'visibleTabCapture'
  | 'menus'
>;

export type FirefoxBasicPopupCapabilities = Pick<
  PopupExtensionCapabilities,
  'persistentStorage' | 'commands' | 'environment'
>;

export function createFirefoxContentCapabilities(
  api: unknown,
): ContentExtensionCapabilities {
  const firefox = firefoxApi(api);
  return {
    runtimeRequests: firefoxRuntimeRequestTransport(firefox.runtime),
    runtimeChannels: firefoxRuntimeChannelClient(firefox.runtime),
    environment: firefoxExtensionEnvironment(firefox.runtime),
  };
}

export function createFirefoxBasicBackgroundCapabilities(
  api: unknown,
): FirefoxBasicBackgroundCapabilities {
  const firefox = firefoxApi(api);
  return {
    installation: firefoxExtensionInstallation(firefox.runtime),
    persistentStorage: firefoxExtensionStorage(
      firefox.storage?.local,
      'persistent',
    ),
    sessionStorage: firefoxExtensionStorage(
      firefox.storage?.session,
      'session',
    ),
    tabMessages: firefoxTabMessageTransport(firefox.tabs),
    visibleTabCapture: firefoxVisibleTabCapture(firefox.tabs),
    menus: firefoxNativeMenus(firefox.menus, firefox.runtime),
  };
}

export function createFirefoxBasicPopupCapabilities(
  api: unknown,
): FirefoxBasicPopupCapabilities {
  const firefox = firefoxApi(api);
  return {
    persistentStorage: firefoxExtensionStorage(
      firefox.storage?.local,
      'persistent',
    ),
    commands: firefoxNativeCommands(firefox.commands),
    environment: firefoxExtensionEnvironment(firefox.runtime),
  };
}

export function createFirefoxExtensionAdapter(
  api: unknown,
  compatibility: ExtensionCompatibilityCapabilities,
): ExtensionCapabilityAdapter {
  const firefox = firefoxApi(api);
  return {
    background() {
      const existing = compatibility.background();
      const basic = createFirefoxBasicBackgroundCapabilities(firefox);
      return {
        ...basic,
        runtimeRequests: firefoxRuntimeRequestServer(firefox.runtime),
        runtimeChannels: firefoxRuntimeChannelServer(firefox.runtime),
        authenticationTabs: firefoxAuthenticationTabs(firefox.tabs),
        commands: firefoxNativeCommands(firefox.commands),
        permissions: existing.permissions,
        cookies: existing.cookies,
        referrerPolicies: existing.referrerPolicies,
        requestHeaderOverride: existing.requestHeaderOverride,
        environment: firefoxExtensionEnvironment(firefox.runtime),
      };
    },
    content() {
      return createFirefoxContentCapabilities(firefox);
    },
    popup() {
      const existing = compatibility.popup();
      const basic = createFirefoxBasicPopupCapabilities(firefox);
      return {
        ...basic,
        runtimeRequests: firefoxRuntimeRequestClient(firefox.runtime),
        authenticationTabs: firefoxAuthenticationTabs(firefox.tabs),
        permissions: existing.permissions,
      };
    },
    pipelineHost() {
      return {
        runtimeRequests: firefoxRuntimeRequestClient(firefox.runtime),
        runtimeChannels: firefoxRuntimeChannelClient(firefox.runtime),
        environment: firefoxExtensionEnvironment(firefox.runtime),
      };
    },
  };
}
