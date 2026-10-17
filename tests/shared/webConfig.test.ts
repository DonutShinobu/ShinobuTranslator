import { describe, expect, it } from 'vitest';
import {
  WEB_SETTINGS_SCHEMA_VERSION,
  createDefaultWebSettings,
  createWebSettingsDraftFromLockedConfig,
  decodeLockedProcessingConfig,
  decodeWebSettings,
  encodeWebSettings,
  inferUiLocale,
  lockProcessingConfig,
  normalizeProviderBaseUrl,
  normalizeProviderTargetBinding,
  restoreWebSettingsFromLockedConfig,
  translationProviderOptions,
  validateProviderBaseUrl,
} from '../../packages/shared-config/src';

describe('web settings schema', () => {
  it('infers traditional Chinese only for Hant locales', () => {
    expect(inferUiLocale('zh-TW')).toBe('zh-TW');
    expect(inferUiLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(inferUiLocale('zh-CN')).toBe('zh-CN');
    expect(inferUiLocale('en-US')).toBe('zh-CN');
  });

  it('uses the interface locale for the first target language', () => {
    expect(createDefaultWebSettings('zh-CN')).toMatchObject({
      targetLanguage: 'zh-CHS',
      processMode: 'translate',
    });
    expect(createDefaultWebSettings('zh-TW')).toMatchObject({
      targetLanguage: 'zh-CHT',
      processMode: 'translate',
    });
  });

  it('offers Bailian with Qwen 3.8 Max by default and preserves the Flash selection', () => {
    const settings = createDefaultWebSettings('zh-CN');
    expect(settings.providerProfiles.alibaba).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
    });
    settings.translationProviderId = 'alibaba';
    settings.providerProfiles.alibaba.model = 'qwen3.8-flash';

    expect(decodeWebSettings(encodeWebSettings(settings))).toEqual({
      settings,
      needsWrite: false,
    });
  });

  it('places Qwen and Doubao between Kimi and MiniMax', () => {
    expect(translationProviderOptions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'deepseek', label: 'DeepSeek' },
      { id: 'glm', label: 'GLM / Z.AI' },
      { id: 'kimi', label: 'Kimi / Moonshot' },
      { id: 'alibaba', label: 'Qwen（阿里云百炼）' },
      { id: 'doubao', label: 'Doubao（火山方舟）' },
      { id: 'minimax', label: 'MiniMax' },
      { id: 'mimo', label: 'MiMo' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'custom', label: 'OpenAI Compatible' },
    ]);
  });

  it('defaults Doubao to Seed Evolving and preserves a selected model across settings round trips', () => {
    const settings = createDefaultWebSettings('zh-CN');
    expect(settings.providerProfiles.doubao).toEqual({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-evolving',
    });
    settings.translationProviderId = 'doubao';
    settings.providerProfiles.doubao.model = 'doubao-seed-2-1-pro-260915';

    expect(decodeWebSettings(encodeWebSettings(settings))).toEqual({
      settings,
      needsWrite: false,
    });
    expect(lockProcessingConfig(settings).provider).toEqual({
      id: 'doubao',
      target: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-2-1-pro-260915',
    });
  });

  it('adds Doubao defaults while preserving older saved provider profiles', () => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'kimi';
    settings.providerProfiles.kimi.model = 'kimi-k2.7-code-highspeed';
    const providerProfiles = { ...settings.providerProfiles };
    Reflect.deleteProperty(providerProfiles, 'doubao');

    const decoded = decodeWebSettings(JSON.stringify({ ...settings, providerProfiles }));
    expect(decoded.needsWrite).toBe(true);
    expect(decoded.settings.translationProviderId).toBe('kimi');
    expect(decoded.settings.providerProfiles.kimi.model).toBe('kimi-k2.7-code-highspeed');
    expect(decoded.settings.providerProfiles.doubao).toEqual(settings.providerProfiles.doubao);
  });

  it.each(['https://other.example/v1', ''])('fixes the Bailian target when stored settings contain %s', (baseUrl) => {
    const settings = createDefaultWebSettings('zh-CN');
    settings.translationProviderId = 'alibaba';
    settings.providerProfiles.alibaba.baseUrl = baseUrl;
    settings.providerProfiles.custom.baseUrl = 'https://custom.example/v1';

    const decoded = decodeWebSettings(encodeWebSettings(settings));
    expect(decoded.needsWrite).toBe(true);
    expect(decoded.settings.providerProfiles.alibaba.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(decoded.settings.providerProfiles.custom.baseUrl).toBe('https://custom.example/v1');
    expect(lockProcessingConfig(settings).provider.target).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('keeps a nonofficial locked Bailian target readable without silently restoring it at a different endpoint', () => {
    const lockedConfig = {
      schemaVersion: 1 as const,
      targetLanguage: 'zh-CHS' as const,
      processMode: 'translate' as const,
      provider: { id: 'alibaba', target: 'https://history.example/v1', model: 'qwen3.8-flash' },
    };
    const current = createDefaultWebSettings('zh-CN');
    expect(decodeLockedProcessingConfig(lockedConfig)).toEqual(lockedConfig);
    expect(restoreWebSettingsFromLockedConfig(lockedConfig, current)).toBeNull();
    expect(createWebSettingsDraftFromLockedConfig(lockedConfig, current)).toEqual({
      settings: current,
      providerSelectionRequired: true,
    });
    expect(lockedConfig.provider.target).toBe('https://history.example/v1');
    expect(restoreWebSettingsFromLockedConfig({
      ...lockedConfig,
      provider: { ...lockedConfig.provider, target: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    }, current)).toMatchObject({
      translationProviderId: 'alibaba',
      providerProfiles: { alibaba: { model: 'qwen3.8-flash' } },
    });
  });

  it('migrates the unversioned field names into the current schema', () => {
    const decoded = decodeWebSettings(JSON.stringify({
      uiLocale: 'zh-TW',
      targetLang: 'zh-CHS',
      processMode: 'erase',
      providerId: 'openai',
    }));

    expect(decoded.needsWrite).toBe(true);
    expect(decoded.settings).toMatchObject({
      schemaVersion: WEB_SETTINGS_SCHEMA_VERSION,
      uiLocale: 'zh-TW',
      targetLanguage: 'zh-CHS',
      processMode: 'erase',
      translationProviderId: 'openai',
    });
  });

  it('sanitizes corrupt persisted values instead of leaking them to callers', () => {
    const decoded = decodeWebSettings(JSON.stringify({
      schemaVersion: WEB_SETTINGS_SCHEMA_VERSION,
      uiLocale: 'xx',
      targetLanguage: 'english',
      processMode: 'unsafe',
      translationProviderId: 'unknown',
    }), 'zh-HK');

    expect(decoded.needsWrite).toBe(true);
    expect(decoded.settings).toEqual(createDefaultWebSettings('zh-TW'));
  });

  it('round trips the current version without requesting a rewrite', () => {
    const settings = {
      ...createDefaultWebSettings('zh-CN'),
      targetLanguage: 'zh-CHT' as const,
      translationProviderId: 'kimi' as const,
    };

    expect(decodeWebSettings(encodeWebSettings(settings))).toEqual({
      settings,
      needsWrite: false,
    });
  });

  it('restores locked processing choices without replacing user preferences', () => {
    const current = createDefaultWebSettings('zh-CN');
    current.providerProfiles.deepseek.model = 'keep-this-profile';
    const restored = restoreWebSettingsFromLockedConfig({
      schemaVersion: 1,
      targetLanguage: 'zh-CHT',
      processMode: 'translate',
      provider: {
        id: 'openai',
        target: 'https://history.example/v1',
        model: 'history-model',
      },
    }, current);

    expect(restored).toMatchObject({
      uiLocale: 'zh-CN',
      targetLanguage: 'zh-CHT',
      processMode: 'translate',
      translationProviderId: 'openai',
      providerProfiles: {
        deepseek: { model: 'keep-this-profile' },
        openai: {
          baseUrl: 'https://history.example/v1',
          model: 'history-model',
        },
      },
    });
    expect(current.translationProviderId).toBe('deepseek');
  });

  it('creates an editable draft when the locked provider no longer exists', () => {
    const current = createDefaultWebSettings('zh-TW');
    current.translationProviderId = 'kimi';
    current.providerProfiles.kimi.model = 'current-kimi';

    const draft = createWebSettingsDraftFromLockedConfig({
      schemaVersion: 1,
      targetLanguage: 'zh-CHS',
      processMode: 'erase',
      provider: {
        id: 'removed-provider',
        target: 'https://removed.example/v1',
        model: 'removed-model',
      },
    }, current);

    expect(draft).toEqual({
      settings: {
        ...current,
        targetLanguage: 'zh-CHS',
        processMode: 'erase',
      },
      providerSelectionRequired: true,
    });
  });

  it('allows HTTPS and loopback HTTP provider URLs only', () => {
    expect(validateProviderBaseUrl('https://api.example.com/v1')).toBeNull();
    expect(validateProviderBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(validateProviderBaseUrl('http://127.25.0.1:8080/v1')).toBeNull();
    expect(validateProviderBaseUrl('http://[::1]:9000/v1')).toBeNull();
    expect(validateProviderBaseUrl('http://192.168.1.2/v1')).toContain('HTTP');
    expect(validateProviderBaseUrl('file:///tmp/model')).toContain('HTTPS');
    expect(validateProviderBaseUrl('https://user:pass@example.com/v1')).toContain('用户名');
    expect(validateProviderBaseUrl('https://example.com/v1?key=value')).toContain('查询参数');
    expect(validateProviderBaseUrl('https://example.com/v1#fragment')).toContain('片段');
    expect(normalizeProviderBaseUrl(' https://example.com/v1/// ')).toBe(
      'https://example.com/v1',
    );
    expect(normalizeProviderTargetBinding('https://EXAMPLE.com:443/v1/')).toBe(
      'https://example.com/v1',
    );
    expect(normalizeProviderTargetBinding('http://127.0.0.1:8080/')).toBe(
      'http://127.0.0.1:8080/',
    );
  });
});
