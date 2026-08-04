import { describe, expect, it } from 'vitest';
import {
  createExtensionSettingsRepository,
} from '../../apps/extension/src/background/extensionControl/settingsRepository';
import {
  createTranslationConfigurationModule,
  TranslationConfigurationConflictError,
} from '../../apps/extension/src/background/extensionControl/translationConfiguration';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';

function createHarness() {
  let settings = {
    ...defaultExtensionSettings,
    llmProfiles: {
      ...defaultExtensionSettings.llmProfiles,
      deepseek: {
        ...defaultExtensionSettings.llmProfiles.deepseek,
        apiKey: 'secret-key',
        modelPreset: 'deepseek-chat',
      },
    },
  };
  let revision = 7;
  const repository = createExtensionSettingsRepository({
    readState: async () => ({ settings, revision }),
    writeState: async (next) => {
      settings = next.settings;
      revision = next.revision;
    },
  });
  return {
    module: createTranslationConfigurationModule(repository),
  };
}

describe('TranslationConfigurationModule', () => {
  it('projects editable settings without exposing provider credentials', async () => {
    const { module } = createHarness();

    const projection = await module.read();

    expect(projection.revision).toBe(7);
    expect(projection.settings.llmProfiles.deepseek).toEqual({
      authMode: 'api_key',
      modelPreset: 'deepseek-chat',
      modelCustom: '',
      useCustomModel: false,
      customBaseUrl: '',
    });
    expect('apiKey' in projection.settings.llmProfiles.deepseek).toBe(false);
  });

  it('keeps an execution snapshot immutable when defaults change later', async () => {
    const { module } = createHarness();
    const before = await module.prepareExecution();
    const projection = await module.read();

    await module.replace({
      ...projection.settings,
      targetLang: 'zh-CHT',
    }, projection.revision);

    const after = await module.prepareExecution();
    expect(before.pipelineConfig?.targetLang).toBe('zh-CHS');
    expect(after.pipelineConfig?.targetLang).toBe('zh-CHT');
    expect(after.revision).toBe(8);
  });

  it('materializes all whole-image semantics before settings can change', async () => {
    const { module } = createHarness();
    const projection = await module.read();
    await module.replace({
      ...projection.settings,
      translator: 'llm',
      llmProvider: 'gemini',
      targetLang: 'zh-CHT',
      geminiAppModel: 'nano_banana_2',
      geminiAppPromptTemplate: 'translate to {targetLang}',
      geminiAppAuthMode: 'browser_session',
      llmProfiles: {
        ...projection.settings.llmProfiles,
        gemini: {
          ...projection.settings.llmProfiles.gemini,
          authMode: 'gemini_app',
        },
      },
    }, projection.revision);

    const snapshot = await module.prepareExecution();
    const changed = await module.read();
    await module.replace({
      ...changed.settings,
      targetLang: 'zh-CHS',
      geminiAppModel: 'nano_banana_pro',
      geminiAppPromptTemplate: 'new prompt {targetLang}',
      geminiAppAuthMode: 'cookies_permission',
    }, changed.revision);

    expect(snapshot.wholeImage).toEqual({
      provider: 'gemini-app',
      model: 'nano_banana_2',
      modelLabel: 'Nano Banana 2',
      prompt: 'translate to 繁体中文',
      authMode: 'cookies_permission',
    });
  });

  it('rejects a stale replacement instead of losing a concurrent update', async () => {
    const { module } = createHarness();
    const projection = await module.read();
    await module.replace({
      ...projection.settings,
      targetLang: 'zh-CHT',
    }, projection.revision);

    await expect(module.replace({
      ...projection.settings,
      processMode: 'erase',
    }, projection.revision)).rejects.toBeInstanceOf(
      TranslationConfigurationConflictError,
    );
  });
});
