import { describe, expect, it, vi } from 'vitest';
import {
  credentialAccessTargetForProfile,
  runCredentialAction,
} from '../../src/popup/authentication';
import type {
  ExtensionPermissions,
  PermissionRequirement,
} from '../../apps/extension/src/capabilities/contracts';

describe('popup credential authorization', () => {
  it('maps every provider authentication mode to its credential access target', () => {
    const apiKeyProfile = {
      apiKey: 'secret',
      authMode: 'api_key' as const,
      modelPreset: 'model',
      modelCustom: '',
      useCustomModel: false,
      customBaseUrl: '',
    };

    expect(credentialAccessTargetForProfile('deepseek', apiKeyProfile)).toEqual({
      kind: 'api-key',
    });
    expect(credentialAccessTargetForProfile('openai', {
      ...apiKeyProfile,
      authMode: 'openai_oauth',
    })).toEqual({
      kind: 'openai-oauth',
    });
    expect(credentialAccessTargetForProfile('gemini', {
      ...apiKeyProfile,
      authMode: 'gemini_app',
    })).toEqual({
      kind: 'gemini-cookie',
    });
    expect(credentialAccessTargetForProfile('custom', {
      ...apiKeyProfile,
      customBaseUrl: 'HTTPS://LLM.Example.TEST:443/v1',
    })).toEqual({
      kind: 'api-key',
      targetEndpoint: 'HTTPS://LLM.Example.TEST:443/v1',
    });
  });

  it('requests the whole Gemini permission set before running the login action', async () => {
    const requested: PermissionRequirement[][] = [];
    const action = vi.fn(async () => 'opened');
    const permissions: ExtensionPermissions = {
      check: vi.fn(),
      async request(requirements) {
        requested.push([...requirements]);
        return {
          status: 'denied',
          missing: [{ kind: 'cookie-access' }],
        };
      },
      onChanged: () => () => undefined,
    };

    await expect(runCredentialAction(
      permissions,
      { kind: 'gemini-cookie' },
      action,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'cookie-access' }],
    });
    expect(requested).toEqual([[
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ]]);
    expect(action).not.toHaveBeenCalled();
  });
});
