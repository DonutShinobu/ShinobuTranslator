import type {
  CookieQuery,
  CookieReadResult,
  ExtensionCookies,
  ExtensionPermissions,
  PermissionChange,
  PermissionCheckResult,
  PermissionRequestResult,
  PermissionRequirement,
} from './contracts';
import {
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
} from './errors';

export type CredentialAccessTarget =
  | Readonly<{
      kind: 'api-key';
      targetEndpoint?: string;
    }>
  | Readonly<{
      kind: 'openai-oauth';
    }>
  | Readonly<{
      kind: 'gemini-cookie';
    }>;

export type AuthenticationPermissionRequired = {
  status: 'permission-required';
  missing: readonly PermissionRequirement[];
};

export type AuthenticationRequirementResult =
  | {
      status: 'granted';
    }
  | AuthenticationPermissionRequired;

export interface AuthenticationAccess {
  check(target: CredentialAccessTarget): Promise<PermissionCheckResult>;
  request(target: CredentialAccessTarget): Promise<PermissionRequestResult>;
  require(
    target: CredentialAccessTarget,
  ): Promise<AuthenticationRequirementResult>;
  onChanged(
    target: CredentialAccessTarget,
    listener: (change: PermissionChange) => void,
  ): () => void;
  readGeminiCookies(query: CookieQuery): Promise<CookieReadResult>;
}

export type AuthenticationCapabilities = Readonly<{
  permissions: ExtensionPermissions;
  cookies: ExtensionCookies;
}>;

export function isAuthenticationPermissionRequired(
  result: unknown,
): result is AuthenticationPermissionRequired {
  return (
    typeof result === 'object'
    && result !== null
    && 'status' in result
    && result.status === 'permission-required'
    && 'missing' in result
    && Array.isArray(result.missing)
  );
}

function normalizeTargetOrigin(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.origin === 'null'
    ) {
      throw new TypeError('Unsupported target endpoint protocol');
    }
    return url.origin;
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

export function credentialPermissionRequirements(
  target: CredentialAccessTarget,
): readonly PermissionRequirement[] {
  if (target.kind === 'gemini-cookie') {
    return [
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ];
  }
  if (target.kind === 'api-key' && target.targetEndpoint) {
    return [
      { kind: 'authentication-data-use' },
      {
        kind: 'target-origin',
        origin: normalizeTargetOrigin(target.targetEndpoint),
      },
    ];
  }
  return [{ kind: 'authentication-data-use' }];
}

export function createAuthenticationAccess(
  capabilities: AuthenticationCapabilities,
): AuthenticationAccess {
  const requirementsFor = (
    target: CredentialAccessTarget,
  ): readonly PermissionRequirement[] => credentialPermissionRequirements(target);

  return {
    check(target) {
      return capabilities.permissions.check(requirementsFor(target));
    },
    async request(target) {
      const requirements = requirementsFor(target);
      const current = await capabilities.permissions.check(requirements);
      if (current.status === 'granted') {
        return current;
      }
      return capabilities.permissions.request(requirements);
    },
    async require(target) {
      const current = await capabilities.permissions.check(
        requirementsFor(target),
      );
      if (current.status === 'not-granted') {
        return {
          status: 'permission-required',
          missing: current.missing,
        };
      }
      return current;
    },
    onChanged(target, listener) {
      return capabilities.permissions.onChanged(
        requirementsFor(target),
        listener,
      );
    },
    readGeminiCookies(query) {
      return capabilities.cookies.read(
        query,
        requirementsFor({ kind: 'gemini-cookie' }),
      );
    },
  };
}
