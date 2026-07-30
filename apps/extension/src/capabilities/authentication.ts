import type {
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
  readGeminiAppCookies(): Promise<CookieReadResult>;
  readGoogleAccountsCookies(): Promise<CookieReadResult>;
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
  return {
    check(target) {
      return capabilities.permissions.check(
        credentialPermissionRequirements(target),
      );
    },
    async request(target) {
      const requirements = credentialPermissionRequirements(target);
      const current = await capabilities.permissions.check(requirements);
      if (current.status === 'granted') {
        return current;
      }
      return capabilities.permissions.request(requirements);
    },
    async require(target) {
      const current = await capabilities.permissions.check(
        credentialPermissionRequirements(target),
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
        credentialPermissionRequirements(target),
        listener,
      );
    },
    readGeminiAppCookies() {
      return capabilities.cookies.read(
        { url: 'https://gemini.google.com/' },
        credentialPermissionRequirements({ kind: 'gemini-cookie' }),
      );
    },
    readGoogleAccountsCookies() {
      return capabilities.cookies.read(
        { url: 'https://accounts.google.com/' },
        credentialPermissionRequirements({ kind: 'gemini-cookie' }),
      );
    },
  };
}
