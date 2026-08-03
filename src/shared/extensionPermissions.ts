import {
  requireExtensionRuntime,
  type ExtensionBrowserApi,
  type ExtensionPermissionRequest,
} from './extensionRuntime';

export class ExtensionPermissionError extends Error {
  readonly code = 'EXTENSION_PERMISSION_DENIED';

  constructor(readonly request: ExtensionPermissionRequest) {
    super('未授予此功能所需的安装权限，请检查扩展权限或重新安装');
    this.name = 'ExtensionPermissionError';
  }
}

export interface ExtensionPermissions {
  contains(request: ExtensionPermissionRequest): Promise<boolean>;
  assertGranted(request: ExtensionPermissionRequest): Promise<void>;
}

function containsExtensionPermission(
  api: ExtensionBrowserApi,
  request: ExtensionPermissionRequest,
): Promise<boolean> {
  const operation = api.permissions?.contains;
  if (!operation) return Promise.resolve(false);

  const normalizedRequest = api.commands?.openShortcutSettings
    ? request
    : {
        permissions: request.permissions,
        origins: request.origins,
      };
  if (
    !normalizedRequest.permissions?.length
    && !normalizedRequest.origins?.length
    && !('data_collection' in normalizedRequest)
  ) {
    return Promise.resolve(true);
  }

  const browserApi = (globalThis as typeof globalThis & { browser?: ExtensionBrowserApi }).browser;
  if (browserApi === api) {
    return Promise.resolve(operation(normalizedRequest) as Promise<boolean>);
  }
  return new Promise((resolve, reject) => {
    operation(normalizedRequest, (result) => {
      const runtimeError = api.runtime?.lastError?.message;
      if (runtimeError) reject(new Error(runtimeError));
      else resolve(result);
    });
  });
}

export function createExtensionPermissions(
  api = requireExtensionRuntime().api,
): ExtensionPermissions {
  return {
    contains: (request) => containsExtensionPermission(api, request),
    async assertGranted(request) {
      if (!await containsExtensionPermission(api, request)) {
        throw new ExtensionPermissionError(request);
      }
    },
  };
}

export const GEMINI_COOKIE_PERMISSION: ExtensionPermissionRequest = {
  permissions: ['cookies'],
};

export const AUTHENTICATION_INFO_PERMISSION: ExtensionPermissionRequest = {
  data_collection: ['authenticationInfo'],
};
