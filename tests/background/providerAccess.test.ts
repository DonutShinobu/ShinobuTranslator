import { describe, expect, it, vi } from 'vitest';
import {
  createProviderAccessModule,
  ProviderAccessActionNotSupportedError,
} from '../../apps/extension/src/background/extensionControl/providerAccess';
import { createExtensionSettingsRepository } from '../../apps/extension/src/background/extensionControl/settingsRepository';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';

function createHarness() {
  let settings = {
    ...defaultExtensionSettings,
    llmProfiles: {
      ...defaultExtensionSettings.llmProfiles,
      deepseek: {
        ...defaultExtensionSettings.llmProfiles.deepseek,
        apiKey: 'existing-secret',
      },
    },
  };
  let revision = 2;
  const repository = createExtensionSettingsRepository({
    readState: async () => ({ settings, revision }),
    writeState: async (next) => {
      settings = next.settings;
      revision = next.revision;
    },
  });
  const openAi = {
    status: vi.fn(async () => ({
      authenticated: true,
      email: 'reader@example.com',
      planType: 'plus',
    })),
    login: vi.fn(async () => ({ authenticated: false, pending: true })),
    logout: vi.fn(async () => ({ authenticated: false })),
  };
  const gemini = {
    status: vi.fn(async () => ({ authenticated: false })),
    login: vi.fn(async () => ({ authenticated: false, pending: true })),
  };
  return {
    module: createProviderAccessModule(repository, { openAi, gemini }),
    openAi,
    gemini,
  };
}

describe('ProviderAccessModule', () => {
  it('projects capability state without returning credential material', async () => {
    const { module, openAi, gemini } = createHarness();

    const projection = await module.read();

    expect(projection.revision).toBe(2);
    expect(projection.apiKeys.deepseek).toEqual({ configured: true });
    expect(projection.apiKeys.openai).toEqual({ configured: false });
    expect(projection.openAiOAuth).toMatchObject({
      state: 'action-required',
      availableActions: ['refresh', 'login'],
    });
    expect(projection.geminiApp).toMatchObject({
      state: 'action-required',
      availableActions: ['refresh', 'login'],
    });
    expect(JSON.stringify(projection)).not.toContain('existing-secret');
    expect(openAi.status).not.toHaveBeenCalled();
    expect(gemini.status).not.toHaveBeenCalled();
    await expect(module.requireApiKey('deepseek')).resolves.toBe('existing-secret');
    await expect(module.revealApiKey('deepseek')).resolves.toBe('existing-secret');
  });

  it('refreshes only the requested authorization target', async () => {
    const { module, openAi, gemini } = createHarness();

    const projection = await module.refresh('openai-oauth');

    expect(projection.openAiOAuth).toMatchObject({
      state: 'ready',
      identity: { email: 'reader@example.com', planType: 'plus' },
    });
    expect(openAi.status).toHaveBeenCalledOnce();
    expect(gemini.status).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refreshes for the same authorization target', async () => {
    const { module, openAi, gemini } = createHarness();
    let finishRefresh!: (status: {
      authenticated: boolean;
      email: string;
      planType: string;
    }) => void;
    openAi.status.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = resolve;
    }));

    const first = module.refresh('openai-oauth');
    const second = module.refresh('openai-oauth');
    await vi.waitFor(() => expect(openAi.status).toHaveBeenCalledOnce());
    finishRefresh({
      authenticated: true,
      email: 'reader@example.com',
      planType: 'plus',
    });
    await Promise.all([first, second]);

    expect(openAi.status).toHaveBeenCalledOnce();
    expect(gemini.status).not.toHaveBeenCalled();
  });

  it('replaces and clears an API key through intent methods', async () => {
    const { module } = createHarness();

    const replaced = await module.replaceApiKey('openai', 'new-secret');
    expect(replaced.revision).toBe(3);
    expect(replaced.apiKeys.openai.configured).toBe(true);

    const cleared = await module.clearApiKey('deepseek');
    expect(cleared.revision).toBe(4);
    expect(cleared.apiKeys.deepseek.configured).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain('new-secret');
  });

  it('owns provider-specific authorization actions', async () => {
    const { module, openAi, gemini } = createHarness();

    await module.perform('openai-oauth', 'login');
    await module.perform('gemini-app', 'login');

    expect(openAi.login).toHaveBeenCalledOnce();
    expect(gemini.login).toHaveBeenCalledOnce();
    expect(openAi.status).not.toHaveBeenCalled();
    expect(gemini.status).not.toHaveBeenCalled();
    await expect(module.perform('gemini-app', 'logout')).rejects.toBeInstanceOf(
      ProviderAccessActionNotSupportedError,
    );
  });

  it('does not let an older refresh overwrite a newer authorization action', async () => {
    const { module, openAi } = createHarness();
    let finishOldRefresh!: (status: {
      authenticated: boolean;
      email: string;
      planType: string;
    }) => void;
    openAi.status.mockImplementationOnce(() => new Promise((resolve) => {
      finishOldRefresh = resolve;
    }));

    const oldRefresh = module.refresh();
    await vi.waitFor(() => expect(openAi.status).toHaveBeenCalledOnce());
    const newerAction = await module.perform('openai-oauth', 'login');
    expect(newerAction.openAiOAuth.state).toBe('authorizing');

    finishOldRefresh({
      authenticated: true,
      email: 'stale@example.com',
      planType: 'free',
    });
    await oldRefresh;

    await expect(module.read()).resolves.toMatchObject({
      openAiOAuth: { state: 'authorizing' },
    });
  });
});
