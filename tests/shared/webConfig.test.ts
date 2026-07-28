import { describe, expect, it } from 'vitest';
import {
  WEB_SETTINGS_SCHEMA_VERSION,
  createDefaultWebSettings,
  decodeWebSettings,
  encodeWebSettings,
  inferUiLocale,
  normalizeProviderBaseUrl,
  normalizeProviderTargetBinding,
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
