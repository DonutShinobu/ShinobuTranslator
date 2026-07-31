import {
  credentialPermissionRequirements,
  type CredentialAccessTarget,
} from '../../apps/extension/src/capabilities/authentication';
import type {
  ExtensionPermissions,
  PermissionRequirement,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  LlmProvider,
  LlmProviderProfile,
} from '../shared/config';

export type CredentialActionResult<T> =
  | {
      status: 'completed';
      value: T;
    }
  | {
      status: 'permission-required';
      missing: readonly PermissionRequirement[];
    };

export function credentialAccessTargetForProfile(
  provider: LlmProvider,
  profile: LlmProviderProfile,
): CredentialAccessTarget {
  if (provider === 'openai' && profile.authMode === 'openai_oauth') {
    return { kind: 'openai-oauth' };
  }
  if (provider === 'gemini' && profile.authMode === 'gemini_app') {
    return { kind: 'gemini-cookie' };
  }
  const targetEndpoint = provider === 'custom'
    ? profile.customBaseUrl.trim()
    : '';
  return {
    kind: 'api-key',
    ...(targetEndpoint ? { targetEndpoint } : {}),
  };
}

export async function runCredentialAction<T>(
  permissions: ExtensionPermissions,
  target: CredentialAccessTarget,
  action: () => Promise<T>,
): Promise<CredentialActionResult<T>> {
  const permissionRequest = permissions.request(
    credentialPermissionRequirements(target),
  );
  const permission = await permissionRequest;
  if (permission.status === 'denied') {
    return {
      status: 'permission-required',
      missing: permission.missing,
    };
  }
  return {
    status: 'completed',
    value: await action(),
  };
}
