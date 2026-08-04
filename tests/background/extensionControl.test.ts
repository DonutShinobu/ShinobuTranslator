import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionControlModule,
  CredentialDisclosureDeniedError,
  ProviderAccessRequiredError,
} from '../../apps/extension/src/background/extensionControl/extensionControl';
import { createProviderAccessModule } from '../../apps/extension/src/background/extensionControl/providerAccess';
import { createExtensionSettingsRepository } from '../../apps/extension/src/background/extensionControl/settingsRepository';
import { createTranslationConfigurationModule } from '../../apps/extension/src/background/extensionControl/translationConfiguration';
import { defaultExtensionSettings, type ExtensionSettings } from '../../apps/extension/src/shared/config';

function createModule(initialSettings: ExtensionSettings, authenticated = false) {
  let settings = initialSettings;
  let revision = 1;
  const repository = createExtensionSettingsRepository({
    readState: async () => ({ settings, revision }),
    writeState: async (next) => {
      settings = next.settings;
      revision = next.revision;
    },
  });
  const configuration = createTranslationConfigurationModule(repository);
  const access = createProviderAccessModule(repository, {
    openAi: {
      status: async () => ({ authenticated }),
      login: async () => ({ authenticated: false, pending: true }),
      logout: async () => ({ authenticated: false }),
    },
    gemini: {
      status: async () => ({ authenticated }),
      login: async () => ({ authenticated: false, pending: true }),
    },
  });
  return createExtensionControlModule(configuration, access);
}

describe('ExtensionControlModule', () => {
  it('blocks a prepared execution when the selected authorization is unavailable', async () => {
    const settings: ExtensionSettings = {
      ...defaultExtensionSettings,
      translator: 'llm',
      llmProvider: 'openai',
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        openai: {
          ...defaultExtensionSettings.llmProfiles.openai,
          authMode: 'openai_oauth',
        },
      },
    };
    const module = createModule(settings);

    await expect(module.handle({ kind: 'prepare-execution' }))
      .rejects.toBeInstanceOf(ProviderAccessRequiredError);
  });

  it('returns an execution snapshot without credential material', async () => {
    const settings: ExtensionSettings = {
      ...defaultExtensionSettings,
      translator: 'llm',
      llmProvider: 'deepseek',
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'never-project-this-secret',
        },
      },
    };
    const module = createModule(settings);

    const result = await module.handle({ kind: 'prepare-execution' });

    expect(result).toMatchObject({
      kind: 'execution-snapshot',
      snapshot: { kind: 'local-pipeline', revision: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('never-project-this-secret');
  });

  it('reveals an API key only through an explicitly authorized capability', async () => {
    const settings: ExtensionSettings = {
      ...defaultExtensionSettings,
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'popup-visible-secret',
        },
      },
    };
    const module = createModule(settings);
    const command = { kind: 'reveal-api-key' as const, provider: 'deepseek' as const };

    await expect(module.handle(command, { canRevealApiKeys: false }))
      .rejects.toBeInstanceOf(CredentialDisclosureDeniedError);
    await expect(module.handle(command, { canRevealApiKeys: true })).resolves.toEqual({
      kind: 'api-key-disclosure',
      provider: 'deepseek',
      apiKey: 'popup-visible-secret',
    });
  });

  it('does not let a failed projection observer invalidate a committed command', async () => {
    const module = createModule(defaultExtensionSettings);
    const failedObserver = vi.fn(() => {
      throw new Error('disconnected projection port');
    });
    module.subscribe(failedObserver);

    await expect(module.handle({
      kind: 'update-interface-preferences',
      preferences: { showElapsedTime: true },
    })).resolves.toMatchObject({
      kind: 'control-projection',
      projection: {
        settings: { showElapsedTime: true },
      },
    });

    await module.handle({
      kind: 'update-interface-preferences',
      preferences: { showElapsedTime: false },
    });
    expect(failedObserver).toHaveBeenCalledOnce();
  });
});
