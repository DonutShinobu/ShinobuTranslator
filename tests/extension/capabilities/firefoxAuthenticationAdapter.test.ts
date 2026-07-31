import { describe, expect, it } from 'vitest';
import {
  firefoxExtensionCookies,
  firefoxExtensionPermissions,
} from '../../../apps/extension/src/capabilities/firefoxPermissions';
import { createListenerEvent } from './listenerEvent.fixture';

describe('Firefox authentication capability adapter', () => {
  it('starts separate optional-only and cookie requests in one authorization flow', async () => {
    const requested: unknown[] = [];
    const added = createListenerEvent<unknown>();
    const removed = createListenerEvent<unknown>();
    const permissions = firefoxExtensionPermissions({
      async contains(details) {
        return (
          details.data_collection?.includes('authenticationInfo') === true
          && details.permissions?.includes('cookies') !== true
        );
      },
      async request(details) {
        requested.push(details);
        return details.data_collection?.includes('authenticationInfo') === true;
      },
      onAdded: added.raw,
      onRemoved: removed.raw,
    });
    const requirements = [
      { kind: 'authentication-data-use' as const },
      { kind: 'cookie-access' as const },
    ];

    const result = permissions.request(requirements);
    await Promise.resolve();
    expect(requested).toEqual([
      { permissions: ['cookies'] },
      { data_collection: ['authenticationInfo'] },
    ]);
    await expect(result).resolves.toEqual({
      status: 'denied',
      missing: [{ kind: 'cookie-access' }],
    });
  });

  it('does not read cookies before authorization and preserves authorized cookie results', async () => {
    const granted = new Set<string>();
    const added = createListenerEvent<unknown>();
    const removed = createListenerEvent<unknown>();
    const permissions = firefoxExtensionPermissions({
      async contains(details) {
        return [
          ...(details.data_collection ?? []),
          ...(details.permissions ?? []),
        ].every((requirement) => granted.has(requirement));
      },
      async request() {
        return false;
      },
      onAdded: added.raw,
      onRemoved: removed.raw,
    });
    let cookieReads = 0;
    let rawCookies: {
      getAll(): Promise<Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
      }>>;
    } | undefined;
    const cookies = firefoxExtensionCookies(() => rawCookies, permissions);
    rawCookies = {
      async getAll() {
        cookieReads += 1;
        return [{
          name: 'SID',
          value: 'cookie-value',
          domain: '.google.com',
          path: '/',
          secure: true,
          httpOnly: true,
        }];
      },
    };
    const requirements = [
      { kind: 'authentication-data-use' as const },
      { kind: 'cookie-access' as const },
    ];

    await expect(cookies.read(
      { url: 'https://gemini.google.com/' },
      requirements,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: requirements,
    });
    expect(cookieReads).toBe(0);

    granted.add('authenticationInfo');
    granted.add('cookies');
    await expect(cookies.read(
      { url: 'https://gemini.google.com/' },
      requirements,
    )).resolves.toEqual({
      status: 'available',
      cookies: [{
        name: 'SID',
        value: 'cookie-value',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
      }],
    });
    expect(cookieReads).toBe(1);
  });

  it('reports invalid target origins through the structured operation error contract', async () => {
    const added = createListenerEvent<unknown>();
    const removed = createListenerEvent<unknown>();
    const permissions = firefoxExtensionPermissions({
      async contains() {
        return false;
      },
      async request() {
        return false;
      },
      onAdded: added.raw,
      onRemoved: removed.raw,
    });

    await expect(permissions.check([{
      kind: 'target-origin',
      origin: 'file:///private/credentials',
    }])).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'extension-permissions',
      operation: 'normalize-origin',
      code: 'serialization-failed',
      retryable: false,
    });
  });
});
