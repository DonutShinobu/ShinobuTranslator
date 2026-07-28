import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import { toWebPipelineConfig } from '../../apps/web/src/runtime/webPipelineConfig';

describe('Web pipeline configuration Adapter', () => {
  it('maps the active provider profile and session key into one task config', () => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'custom';
    settings.providerProfiles.custom = {
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };

    expect(toWebPipelineConfig(settings, 'session-secret')).toMatchObject({
      sourceLang: 'ja',
      targetLang: 'zh-CHS',
      translator: 'llm',
      llmProvider: 'custom',
      llmAuthMode: 'api_key',
      llmBaseUrl: 'http://localhost:11434/v1',
      llmApiKey: 'session-secret',
      llmModel: 'local-model',
      llmUseCustomModel: true,
      processMode: 'translate',
    });
  });
});
