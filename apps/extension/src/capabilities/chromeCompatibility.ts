import type {
  BackgroundExtensionCapabilities,
  ExtensionCookies,
  PopupExtensionCapabilities,
} from './contracts';
import {
  chromeApi,
} from './chromeInternal';
import {
  extensionCookies,
  extensionPermissions,
} from './chromePermissions';
import type {
  ExtensionCompatibilityCapabilities,
} from './compatibility';

export function createChromeCompatibilityCapabilities(
  api: unknown,
): ExtensionCompatibilityCapabilities {
  const chrome = chromeApi(api);
  let background:
    | Pick<
        BackgroundExtensionCapabilities,
        | 'permissions'
        | 'cookies'
      >
    | undefined;
  const capabilities = () => {
    if (background) return background;
    const permissions = extensionPermissions(
      chrome.runtime,
      chrome.permissions,
    );
    const cookies: ExtensionCookies = {
      async read(query, requirements) {
        return await extensionCookies(
          chrome.runtime,
          chrome.cookies,
          permissions,
        ).read(query, requirements);
      },
    };
    background = {
      permissions,
      cookies,
    };
    return background;
  };
  return {
    background: capabilities,
    popup(): Pick<PopupExtensionCapabilities, 'permissions'> {
      return {
        permissions: capabilities().permissions,
      };
    },
  };
}
