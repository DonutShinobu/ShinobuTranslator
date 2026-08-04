import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenAiOAuthStatus,
  openAiOAuthStorageKey,
} from '../../apps/extension/src/background/openai/oauthService';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenAI OAuth status projection', () => {
  it('does not report stored tokens as ready after permission revocation', async () => {
    const stored = {
      idToken: 'id-token',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accountId: 'account',
      email: 'reader@example.com',
      planType: 'plus',
      expiresAt: Date.now() + 60_000,
      lastRefresh: Date.now(),
    };
    vi.stubGlobal('chrome', {
      runtime: {},
      commands: {
        openShortcutSettings: async () => undefined,
      },
      storage: {
        local: {
          get(keys: string[], callback: (items: Record<string, unknown>) => void) {
            const key = keys[0]!;
            callback({ [key]: key === openAiOAuthStorageKey ? stored : undefined });
          },
        },
      },
      permissions: {
        contains(_request: unknown, callback: (granted: boolean) => void) {
          callback(false);
        },
      },
    });

    await expect(getOpenAiOAuthStatus()).resolves.toMatchObject({
      authenticated: false,
      error: expect.stringContaining('权限已被撤销'),
    });
  });
});
