import type { PipelineConfig } from '../types';

export const extensionSettingsStorageKey = 'mangaTranslate.settings';

export type ExtensionSettings = {
  sourceLang: string;
  targetLang: string;
  translator: PipelineConfig['translator'];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
};

export const defaultExtensionSettings: ExtensionSettings = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'llm',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  showElapsedTime: false,
  showStageTimingDetails: false,
};

function sanitizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== 'object') {
    return { ...defaultExtensionSettings };
  }
  const raw = value as Partial<Record<keyof ExtensionSettings, unknown>>;
  const translator = raw.translator === 'youdao' ? 'youdao' : 'llm';
  const showElapsedTime = sanitizeBoolean(raw.showElapsedTime, defaultExtensionSettings.showElapsedTime);
  return {
    sourceLang: sanitizeString(raw.sourceLang, defaultExtensionSettings.sourceLang),
    targetLang: sanitizeString(raw.targetLang, defaultExtensionSettings.targetLang),
    translator,
    llmBaseUrl: sanitizeString(raw.llmBaseUrl, defaultExtensionSettings.llmBaseUrl),
    llmApiKey: typeof raw.llmApiKey === 'string' ? raw.llmApiKey.trim() : defaultExtensionSettings.llmApiKey,
    llmModel: sanitizeString(raw.llmModel, defaultExtensionSettings.llmModel),
    showElapsedTime,
    showStageTimingDetails: showElapsedTime
      ? sanitizeBoolean(raw.showStageTimingDetails, defaultExtensionSettings.showStageTimingDetails)
      : false,
  };
}

export function validateSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') {
    return null;
  }
  if (!settings.llmBaseUrl.trim()) {
    return 'LLM Base URL 不能为空';
  }
  if (!settings.llmModel.trim()) {
    return 'LLM 模型不能为空';
  }
  if (!settings.llmApiKey.trim()) {
    return 'LLM API Key 不能为空';
  }
  return null;
}

export function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  return {
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmBaseUrl: settings.llmBaseUrl,
    llmApiKey: settings.llmApiKey,
    llmModel: settings.llmModel,
  };
}
