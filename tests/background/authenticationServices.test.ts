import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthenticationAccess,
  credentialPermissionRequirements,
  type AuthenticationAccess,
  type CredentialAccessTarget,
} from '../../apps/extension/src/capabilities/authentication';
import type {
  ExtensionCookies,
  ExtensionPermissions,
  ExtensionStorage,
  JsonValue,
  PermissionRequirement,
} from '../../apps/extension/src/capabilities/contracts';
import { ExtensionOperationError } from '../../apps/extension/src/capabilities/errors';
import {
  getGeminiAppAuthStatus,
} from '../../src/background/geminiAppClient';
import {
  loginGeminiApp,
} from '../../src/background/gemini/authService';
import {
  createOpenAiOAuthService,
  openAiOAuthLastErrorStorageKey,
  openAiOAuthPendingStorageKey,
} from '../../src/background/openai/oauthService';
import {
  createProviderService,
} from '../../src/background/providers/providerService';
import {
  defaultExtensionSettings,
} from '../../src/shared/config';

function createDeniedAccess() {
  const check = vi.fn(async (
    requirements: readonly PermissionRequirement[],
  ) => ({
    status: 'not-granted' as const,
    missing: requirements,
  }));
  const request = vi.fn(async (
    requirements: readonly PermissionRequirement[],
  ) => ({
    status: 'denied' as const,
    missing: requirements,
  }));
  const permissions: ExtensionPermissions = {
    check,
    request,
    onChanged: () => () => undefined,
  };
  const cookies: ExtensionCookies = {
    read: vi.fn(async (_query, requirements) => ({
      status: 'permission-required' as const,
      missing: requirements,
    })),
  };
  return {
    access: createAuthenticationAccess({ permissions, cookies }),
    check,
    request,
    cookies,
  };
}

function createAuthenticationTabs() {
  return {
    open: vi.fn(async () => ({ status: 'opened' as const, tabId: 41 })),
    close: vi.fn(async () => ({ status: 'closed' as const })),
    onNavigation: vi.fn(() => () => undefined),
    onClosed: vi.fn(() => () => undefined),
  };
}

function createMemoryStorage(initial: Record<string, JsonValue> = {}) {
  const values = { ...initial };
  const read = vi.fn(async (keys: readonly string[]) => (
    Object.fromEntries(keys.map((key) => [key, values[key]]))
  ));
  const storage: ExtensionStorage = {
    read,
    async write(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of keys) delete values[key];
    },
  };
  return { storage, values, read };
}

function createProviders(authentication: AuthenticationAccess) {
  return createProviderService({
    getSettings: async () => defaultExtensionSettings,
    diagnostics: {
      recordBackground: vi.fn(async () => undefined),
    },
    authentication,
    openAiOAuth: {
      getInstallationId: vi.fn(async () => 'installation-1'),
      getValidTokens: vi.fn(async () => {
        throw new Error('OAuth tokens must not be read without permission');
      }),
      refreshTokens: vi.fn(async (tokens) => tokens),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background authentication services', () => {
  it('checks OAuth status without requesting and stops before reading stored credentials', async () => {
    const denied = createDeniedAccess();
    const memory = createMemoryStorage();
    const oauth = createOpenAiOAuthService({
      storage: memory.storage,
      authenticationTabs: createAuthenticationTabs(),
      authentication: denied.access,
    });

    await expect(oauth.status()).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'authentication-data-use' }],
    });
    expect(denied.check).toHaveBeenCalledTimes(1);
    expect(denied.request).not.toHaveBeenCalled();
    expect(memory.read).not.toHaveBeenCalled();
  });

  it('requests OAuth authorization only from login and never opens a tab after denial', async () => {
    const denied = createDeniedAccess();
    const authenticationTabs = createAuthenticationTabs();
    const oauth = createOpenAiOAuthService({
      storage: createMemoryStorage().storage,
      authenticationTabs,
      authentication: denied.access,
    });

    await expect(oauth.login()).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'authentication-data-use' }],
    });
    expect(denied.request).toHaveBeenCalledWith([
      { kind: 'authentication-data-use' },
    ]);
    expect(authenticationTabs.open).not.toHaveBeenCalled();
  });

  it('requires authentication data and cookie access together before Gemini login or status reads', async () => {
    const denied = createDeniedAccess();
    const authenticationTabs = createAuthenticationTabs();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginGeminiApp(
      defaultExtensionSettings,
      denied.access,
      authenticationTabs,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: [
        { kind: 'authentication-data-use' },
        { kind: 'cookie-access' },
      ],
    });
    expect(denied.request).toHaveBeenCalledWith([
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ]);
    expect(authenticationTabs.open).not.toHaveBeenCalled();

    await expect(getGeminiAppAuthStatus(
      defaultExtensionSettings,
      denied.access,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: [
        { kind: 'authentication-data-use' },
        { kind: 'cookie-access' },
      ],
    });
    expect(denied.cookies.read).toHaveBeenCalledWith(
      { url: 'https://gemini.google.com/' },
      [
        { kind: 'authentication-data-use' },
        { kind: 'cookie-access' },
      ],
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an authorized empty Gemini Cookie list as unauthenticated instead of permission-required', async () => {
    const readGeminiCookies = vi.fn(async () => ({
      status: 'available' as const,
      cookies: [],
    }));
    const access = {
      check: vi.fn(async () => ({ status: 'granted' as const })),
      request: vi.fn(async () => ({ status: 'granted' as const })),
      require: vi.fn(async () => ({ status: 'granted' as const })),
      onChanged: () => () => undefined,
      readGeminiCookies,
    };
    const fetchMock = vi.fn(async () => new Response('<html>sign in</html>'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getGeminiAppAuthStatus(
      defaultExtensionSettings,
      access,
    )).resolves.toEqual({
      authenticated: false,
      error: expect.stringContaining('登录状态不可用'),
    });
    expect(readGeminiCookies).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Cookie adapter failures and does not open the Gemini login page', async () => {
    const cookieFailure = new ExtensionOperationError({
      capability: 'extension-cookies',
      operation: 'read',
      code: 'browser-rejected',
      retryable: true,
    });
    const access: AuthenticationAccess = {
      check: vi.fn(async () => ({ status: 'granted' as const })),
      request: vi.fn(async () => ({ status: 'granted' as const })),
      require: vi.fn(async () => ({ status: 'granted' as const })),
      onChanged: () => () => undefined,
      readGeminiCookies: vi.fn(async () => {
        throw cookieFailure;
      }),
    };
    const authenticationTabs = createAuthenticationTabs();

    await expect(getGeminiAppAuthStatus(
      defaultExtensionSettings,
      access,
    )).rejects.toBe(cookieFailure);
    await expect(loginGeminiApp(
      defaultExtensionSettings,
      access,
      authenticationTabs,
    )).rejects.toBe(cookieFailure);
    expect(authenticationTabs.open).not.toHaveBeenCalled();
  });

  it('rechecks OAuth authorization before exchanging a callback after revocation', async () => {
    let granted = true;
    const permissions: ExtensionPermissions = {
      async check(requirements) {
        return granted
          ? { status: 'granted' }
          : { status: 'not-granted', missing: requirements };
      },
      async request(requirements) {
        return granted
          ? { status: 'granted' }
          : { status: 'denied', missing: requirements };
      },
      onChanged: () => () => undefined,
    };
    const access = createAuthenticationAccess({
      permissions,
      cookies: {
        read: vi.fn(),
      },
    });
    const memory = createMemoryStorage();
    const authenticationTabs = createAuthenticationTabs();
    const oauth = createOpenAiOAuthService({
      storage: memory.storage,
      authenticationTabs,
      authentication: access,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await oauth.login();
    const pending = memory.values[openAiOAuthPendingStorageKey] as {
      state: string;
    };
    granted = false;
    await expect(oauth.handleCallbackUrl(
      41,
      `http://localhost:1457/auth/callback?code=authorization-code&state=${pending.state}`,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'authentication-data-use' }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(memory.values[openAiOAuthPendingStorageKey]).toBeUndefined();
    expect(memory.values[openAiOAuthLastErrorStorageKey]).toBe(
      'Credential authorization is required',
    );
  });

  it('keeps API Key and OAuth dispatch distinct without a silent fallback', async () => {
    const targets: CredentialAccessTarget[] = [];
    const require = vi.fn(async (target: CredentialAccessTarget) => {
      targets.push(target);
      return {
        status: 'permission-required' as const,
        missing: credentialPermissionRequirements(target),
      };
    });
    const access: AuthenticationAccess = {
      check: vi.fn(async () => ({ status: 'granted' as const })),
      request: vi.fn(async () => ({ status: 'granted' as const })),
      require,
      onChanged: () => () => undefined,
      readGeminiCookies: vi.fn(),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get(keys: string[], callback: (items: Record<string, unknown>) => void) {
            callback(Object.fromEntries(
              keys.map((key) => [key, defaultExtensionSettings]),
            ));
          },
        },
      },
    });
    const body = {
      model: 'test-model',
      messages: [{ role: 'user' as const, content: 'translate' }],
    };
    const providers = createProviders(access);

    await expect(providers.llm({
      type: 'mt:llm-chat-completions',
      body,
      proxyConfig: {
        provider: 'openai',
        authMode: 'openai_oauth',
        baseUrl: 'https://api.openai.com/v1',
      },
    })).resolves.toMatchObject({
      ok: false,
      permission: {
        status: 'permission-required',
        missing: [{ kind: 'authentication-data-use' }],
      },
    });
    await expect(providers.llm({
      type: 'mt:llm-chat-completions',
      body,
      proxyConfig: {
        provider: 'openai',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
      },
    })).resolves.toMatchObject({
      ok: false,
      permission: {
        status: 'permission-required',
        missing: [{ kind: 'authentication-data-use' }],
      },
    });
    await expect(providers.llm({
      type: 'mt:llm-chat-completions',
      body,
      proxyConfig: {
        provider: 'custom',
        authMode: 'api_key',
        baseUrl: 'https://llm.example.test/v1',
      },
    })).resolves.toMatchObject({
      ok: false,
      permission: {
        status: 'permission-required',
        missing: [
          { kind: 'authentication-data-use' },
          {
            kind: 'target-origin',
            origin: 'https://llm.example.test',
          },
        ],
      },
    });

    expect(targets).toEqual([
      { kind: 'openai-oauth' },
      { kind: 'api-key' },
      {
        kind: 'api-key',
        targetEndpoint: 'https://llm.example.test/v1',
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(providers.llm({
      type: 'mt:llm-chat-completions',
      body,
      proxyConfig: {
        provider: 'openai',
        authMode: 'gemini_app',
        baseUrl: 'https://api.openai.com/v1',
      },
    })).rejects.toThrow('当前 LLM 认证方式不受支持');
    expect(require).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
