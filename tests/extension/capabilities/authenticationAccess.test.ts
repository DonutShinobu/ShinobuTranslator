import { describe, expect, it, vi } from 'vitest';
import {
  createAuthenticationAccess,
  credentialPermissionRequirements,
} from '../../../apps/extension/src/capabilities/authentication';
import type {
  ExtensionCookies,
  ExtensionPermissions,
  PermissionChange,
  PermissionRequirement,
} from '../../../apps/extension/src/capabilities/contracts';

function requirementKey(requirement: PermissionRequirement): string {
  return requirement.kind === 'target-origin'
    ? `${requirement.kind}:${requirement.origin}`
    : requirement.kind;
}

function createPermissionHarness(initial: readonly PermissionRequirement[] = []) {
  const granted = new Set(initial.map(requirementKey));
  const requests: PermissionRequirement[][] = [];
  let listener:
    | ((change: PermissionChange) => void)
    | undefined;
  let listenerRequirements: readonly PermissionRequirement[] = [];

  const missing = (
    requirements: readonly PermissionRequirement[],
  ): readonly PermissionRequirement[] => requirements.filter(
    (requirement) => !granted.has(requirementKey(requirement)),
  );
  const permissions: ExtensionPermissions = {
    async check(requirements) {
      const absent = missing(requirements);
      return absent.length === 0
        ? { status: 'granted' }
        : { status: 'not-granted', missing: absent };
    },
    async request(requirements) {
      requests.push([...requirements]);
      const absent = missing(requirements);
      return absent.length === 0
        ? { status: 'granted' }
        : { status: 'denied', missing: absent };
    },
    onChanged(requirements, nextListener) {
      listenerRequirements = requirements;
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
  };

  return {
    permissions,
    requests,
    grant(requirement: PermissionRequirement) {
      granted.add(requirementKey(requirement));
    },
    emit(change: PermissionChange) {
      listener?.(change);
    },
    listenerRequirements() {
      return listenerRequirements;
    },
  };
}

describe('authentication access contract', () => {
  it('keeps credential modes distinct and normalizes custom endpoint origins', () => {
    expect(credentialPermissionRequirements({
      kind: 'api-key',
    })).toEqual([
      { kind: 'authentication-data-use' },
    ]);
    expect(credentialPermissionRequirements({
      kind: 'api-key',
      targetEndpoint: 'HTTPS://API.Example.COM:443/v1/chat/completions?model=test',
    })).toEqual([
      { kind: 'authentication-data-use' },
      { kind: 'target-origin', origin: 'https://api.example.com' },
    ]);
    expect(credentialPermissionRequirements({
      kind: 'openai-oauth',
    })).toEqual([
      { kind: 'authentication-data-use' },
    ]);
    expect(credentialPermissionRequirements({
      kind: 'gemini-cookie',
    })).toEqual([
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ]);
  });

  it('checks before requesting and preserves granted, denied, and revoked semantics', async () => {
    const harness = createPermissionHarness([
      { kind: 'authentication-data-use' },
    ]);
    const cookies: ExtensionCookies = {
      read: vi.fn(async () => ({
        status: 'available' as const,
        cookies: [],
      })),
    };
    const access = createAuthenticationAccess({
      permissions: harness.permissions,
      cookies,
    });
    const changes: PermissionChange[] = [];
    const cancel = access.onChanged(
      { kind: 'gemini-cookie' },
      (change) => changes.push(change),
    );

    await expect(access.check({
      kind: 'gemini-cookie',
    })).resolves.toEqual({
      status: 'not-granted',
      missing: [{ kind: 'cookie-access' }],
    });
    await expect(access.request({
      kind: 'gemini-cookie',
    })).resolves.toEqual({
      status: 'denied',
      missing: [{ kind: 'cookie-access' }],
    });
    expect(harness.requests).toEqual([[
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ]]);
    expect(harness.listenerRequirements()).toEqual([
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ]);

    harness.grant({ kind: 'cookie-access' });
    await expect(access.request({
      kind: 'gemini-cookie',
    })).resolves.toEqual({ status: 'granted' });
    expect(harness.requests).toHaveLength(1);

    harness.emit({
      status: 'revoked',
      requirements: [{ kind: 'cookie-access' }],
    });
    expect(changes).toEqual([{
      status: 'revoked',
      requirements: [{ kind: 'cookie-access' }],
    }]);
    cancel();
  });

  it('returns permission-required before cookie access and treats an authorized empty list as available', async () => {
    const harness = createPermissionHarness();
    const cookieReads: Array<{
      requirements: readonly PermissionRequirement[];
    }> = [];
    const cookies: ExtensionCookies = {
      async read(_query, requirements) {
        cookieReads.push({ requirements });
        const permission = await harness.permissions.check(requirements);
        return permission.status === 'granted'
          ? { status: 'available', cookies: [] }
          : {
              status: 'permission-required',
              missing: permission.missing,
            };
      },
    };
    const access = createAuthenticationAccess({
      permissions: harness.permissions,
      cookies,
    });

    await expect(access.readGeminiCookies({
      url: 'https://gemini.google.com/',
    })).resolves.toEqual({
      status: 'permission-required',
      missing: [
        { kind: 'authentication-data-use' },
        { kind: 'cookie-access' },
      ],
    });
    expect(cookieReads).toEqual([{
      requirements: [
        { kind: 'authentication-data-use' },
        { kind: 'cookie-access' },
      ],
    }]);

    harness.grant({ kind: 'authentication-data-use' });
    harness.grant({ kind: 'cookie-access' });
    await expect(access.readGeminiCookies({
      url: 'https://gemini.google.com/',
    })).resolves.toEqual({
      status: 'available',
      cookies: [],
    });
  });

  it('checks but never requests during runtime authorization', async () => {
    const harness = createPermissionHarness();
    const access = createAuthenticationAccess({
      permissions: harness.permissions,
      cookies: {
        read: vi.fn(),
      },
    });

    await expect(access.require({
      kind: 'openai-oauth',
    })).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'authentication-data-use' }],
    });
    expect(harness.requests).toHaveLength(0);
  });
});
