import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import { toWebPipelineConfig } from '../../apps/web/src/runtime/webPipelineConfig';

describe('Web pipeline configuration Adapter', () => {
  it('uses the official Bailian endpoint even when a caller supplies a different profile URL', () => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'alibaba';
    settings.providerProfiles.alibaba.baseUrl = 'https://ignored.example/v1';
    settings.providerProfiles.alibaba.model = 'qwen3.8-flash';

    expect(toWebPipelineConfig(settings)).toMatchObject({
      llmProvider: 'alibaba',
      llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      llmModel: 'qwen3.8-flash',
    });
  });

  it('maps result semantics without placing the session key in task config', () => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'custom';
    settings.providerProfiles.custom = {
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    };

    const config = toWebPipelineConfig(settings);
    expect(config).toMatchObject({
      sourceLang: 'ja',
      targetLang: 'zh-CHS',
      translator: 'llm',
      llmProvider: 'custom',
      llmAuthMode: 'api_key',
      llmBaseUrl: 'http://localhost:11434/v1',
      llmModel: 'local-model',
      llmUseCustomModel: true,
      processMode: 'translate',
    });
    expect(config).not.toHaveProperty('llmApiKey');
    expect(JSON.stringify(config)).not.toContain('session-secret');
  });
});
