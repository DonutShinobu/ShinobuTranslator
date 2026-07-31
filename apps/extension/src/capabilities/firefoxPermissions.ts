import type {
  ExtensionCookies,
  ExtensionPermissions,
  PermissionRequirement,
} from './contracts';
import {
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
} from './errors';
import {
  idempotentCancel,
  requireFunction,
  requireNamespace,
} from './adapterInternal';
import {
  firefoxPromise,
  type FirefoxCookies,
  type FirefoxPermissionDetails,
  type FirefoxPermissions,
} from './firefoxInternal';

function normalizedOrigin(
  requirement: PermissionRequirement,
): string | undefined {
  if (requirement.kind !== 'target-origin') return undefined;
  try {
    const url = new URL(requirement.origin);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.origin === 'null'
    ) {
      throw new TypeError('Unsupported target origin protocol');
    }
    return `${url.origin}/*`;
  } catch (error) {
    throw new ExtensionOperationError({
      capability: 'extension-permissions',
      operation: 'normalize-origin',
      code: 'serialization-failed',
      retryable: false,
      diagnostic: sanitizedErrorDiagnostic(error),
      cause: error,
    });
  }
}

function permissionDetails(
  requirements: readonly PermissionRequirement[],
): FirefoxPermissionDetails {
  const permissions = requirements.some(
    (requirement) => requirement.kind === 'cookie-access',
  )
    ? ['cookies']
    : undefined;
  const dataCollection = requirements.some(
    (requirement) => requirement.kind === 'authentication-data-use',
  )
    ? ['authenticationInfo']
    : undefined;
  const origins = requirements.flatMap((requirement) => {
    const origin = normalizedOrigin(requirement);
    return origin ? [origin] : [];
  });
  return {
    ...(permissions ? { permissions } : {}),
    ...(origins.length > 0 ? { origins } : {}),
    ...(dataCollection ? { data_collection: dataCollection } : {}),
  };
}

function permissionRequestDetails(
  requirements: readonly PermissionRequirement[],
): readonly FirefoxPermissionDetails[] {
  const dataCollection = requirements.filter(
    (requirement) => requirement.kind === 'authentication-data-use',
  );
  const standardPermissions = requirements.filter(
    (requirement) => requirement.kind !== 'authentication-data-use',
  );
  return [
    ...(standardPermissions.length > 0
      ? [permissionDetails(standardPermissions)]
      : []),
    ...(dataCollection.length > 0 ? [permissionDetails(dataCollection)] : []),
  ];
}

function changedRequirements(
  requirements: readonly PermissionRequirement[],
  details: FirefoxPermissionDetails,
): readonly PermissionRequirement[] {
  return requirements.filter((requirement) => {
    if (requirement.kind === 'authentication-data-use') {
      return details.data_collection?.includes('authenticationInfo') ?? false;
    }
    if (requirement.kind === 'cookie-access') {
      return details.permissions?.includes('cookies') ?? false;
    }
    const origin = normalizedOrigin(requirement);
    return origin ? details.origins?.includes(origin) ?? false : false;
  });
}

export function firefoxExtensionPermissions(
  rawPermissions: FirefoxPermissions | undefined,
): ExtensionPermissions {
  const permissions = requireNamespace(
    rawPermissions,
    'extension-permissions',
    'permissions',
  );
  requireFunction(permissions.contains, 'extension-permissions', 'check');
  requireFunction(permissions.request, 'extension-permissions', 'request');
  requireFunction(
    permissions.onAdded?.addListener,
    'extension-permissions',
    'onChanged',
  );
  requireFunction(
    permissions.onAdded?.removeListener,
    'extension-permissions',
    'cancel:onChanged',
  );
  requireFunction(
    permissions.onRemoved?.addListener,
    'extension-permissions',
    'onChanged',
  );
  requireFunction(
    permissions.onRemoved?.removeListener,
    'extension-permissions',
    'cancel:onChanged',
  );

  const missingRequirements = async (
    requirements: readonly PermissionRequirement[],
  ): Promise<readonly PermissionRequirement[]> => {
    const decisions = await Promise.all(requirements.map(async (requirement) => {
      const granted = await firefoxPromise(
        'extension-permissions',
        'check',
        () => permissions.contains(permissionDetails([requirement])),
      );
      return granted ? undefined : requirement;
    }));
    return decisions.filter(
      (requirement): requirement is PermissionRequirement => requirement !== undefined,
    );
  };

  return {
    async check(requirements) {
      const granted = await firefoxPromise(
        'extension-permissions',
        'check',
        () => permissions.contains(permissionDetails(requirements)),
      );
      if (granted) return { status: 'granted' };
      const missing = await missingRequirements(requirements);
      return missing.length === 0
        ? { status: 'granted' }
        : { status: 'not-granted', missing };
    },
    async request(requirements) {
      const requests = permissionRequestDetails(requirements).map(
        (details) => firefoxPromise(
          'extension-permissions',
          'request',
          () => permissions.request(details),
        ),
      );
      const decisions = await Promise.all(requests);
      if (decisions.every(Boolean)) return { status: 'granted' };
      const missing = await missingRequirements(requirements);
      return missing.length === 0
        ? { status: 'granted' }
        : { status: 'denied', missing };
    },
    onChanged(requirements, listener) {
      const added = (details: FirefoxPermissionDetails): void => {
        const changed = changedRequirements(requirements, details);
        if (changed.length > 0) {
          listener({ status: 'granted', requirements: changed });
        }
      };
      const removed = (details: FirefoxPermissionDetails): void => {
        const changed = changedRequirements(requirements, details);
        if (changed.length > 0) {
          listener({ status: 'revoked', requirements: changed });
        }
      };
      permissions.onAdded.addListener(added);
      permissions.onRemoved.addListener(removed);
      return idempotentCancel(() => {
        permissions.onAdded.removeListener(added);
        permissions.onRemoved.removeListener(removed);
      });
    },
  };
}

export function firefoxExtensionCookies(
  rawCookies:
    | FirefoxCookies
    | undefined
    | (() => FirefoxCookies | undefined),
  permissions: ExtensionPermissions,
): ExtensionCookies {
  const resolveCookies = typeof rawCookies === 'function'
    ? rawCookies
    : () => rawCookies;
  return {
    async read(query, requirements) {
      const permission = await permissions.check(requirements);
      if (permission.status === 'not-granted') {
        return {
          status: 'permission-required',
          missing: permission.missing,
        };
      }
      const cookies = resolveCookies();
      if (!cookies || typeof cookies.getAll !== 'function') {
        throw new ExtensionOperationError({
          capability: 'extension-cookies',
          operation: 'read',
          code: 'context-unavailable',
          retryable: false,
          diagnostic: {
            missing: 'cookies',
          },
        });
      }
      const values = await firefoxPromise(
        'extension-cookies',
        'read',
        () => cookies.getAll(query),
      );
      const normalized = values.map((cookie) => {
        for (const field of ['name', 'value', 'domain', 'path'] as const) {
          if (typeof cookie[field] !== 'string') {
            throw new ExtensionOperationError({
              capability: 'extension-cookies',
              operation: 'read',
              code: 'serialization-failed',
              retryable: false,
              diagnostic: {
                invalidField: field,
              },
            });
          }
        }
        const stringCookie = cookie as typeof cookie & {
          name: string;
          value: string;
          domain: string;
          path: string;
        };
        return {
          name: stringCookie.name,
          value: stringCookie.value,
          domain: stringCookie.domain,
          path: stringCookie.path,
          secure: cookie.secure === true,
          httpOnly: cookie.httpOnly === true,
          ...(typeof cookie.expirationDate === 'number'
            ? { expirationDate: cookie.expirationDate }
            : {}),
        };
      });
      return {
        status: 'available',
        cookies: normalized,
      };
    },
  };
}
