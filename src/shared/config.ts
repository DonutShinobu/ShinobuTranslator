import type { PipelineConfig } from '../types';

export const extensionSettingsStorageKey = 'mangaTranslate.settings';

export type LlmProvider = PipelineConfig['llmProvider'];
export type BuiltInLlmProvider = Exclude<LlmProvider, 'custom'>;

type BuiltInProviderDefinition = {
  label: string;
  baseUrl: string;
  models: string[];
};

export const llmBuiltInProviderDefinitions: Record<BuiltInLlmProvider, BuiltInProviderDefinition> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  glm: {
    label: 'GLM (Z.AI)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6', 'glm-4.5-airx'],
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2-0711-preview', 'kimi-k2-turbo-preview', 'kimi-k2.5'],
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2'],
  },
};

export const llmProviderOptions: Array<{ value: LlmProvider; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'glm', label: 'GLM (Z.AI)' },
  { value: 'kimi', label: 'Kimi (Moonshot)' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'custom', label: '自定义提供商' },
];

const builtInProviders = Object.keys(llmBuiltInProviderDefinitions) as BuiltInLlmProvider[];

function isLlmProvider(value: unknown): value is LlmProvider {
  return value === 'deepseek' || value === 'glm' || value === 'kimi' || value === 'minimax' || value === 'custom';
}

function isBuiltInProvider(provider: LlmProvider): provider is BuiltInLlmProvider {
  return provider !== 'custom';
}

function detectBuiltInProviderByBaseUrl(baseUrl: string): BuiltInLlmProvider | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) {
    return null;
  }
  for (const provider of builtInProviders) {
    const candidate = llmBuiltInProviderDefinitions[provider].baseUrl.replace(/\/+$/, '').toLowerCase();
    if (candidate === normalized) {
      return provider;
    }
  }
  return null;
}

function getDefaultModelPreset(provider: BuiltInLlmProvider): string {
  return llmBuiltInProviderDefinitions[provider].models[0] ?? '';
}

export type ExtensionSettings = {
  sourceLang: string;
  targetLang: string;
  translator: PipelineConfig['translator'];
  llmProvider: LlmProvider;
  llmModelPreset: string;
  llmModelCustom: string;
  llmUseCustomModel: boolean;
  llmCustomBaseUrl: string;
  llmApiKey: string;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
};

export const defaultExtensionSettings: ExtensionSettings = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'google_web',
  llmProvider: 'deepseek',
  llmModelPreset: getDefaultModelPreset('deepseek'),
  llmModelCustom: '',
  llmUseCustomModel: false,
  llmCustomBaseUrl: '',
  llmApiKey: '',
  showElapsedTime: false,
  showStageTimingDetails: false,
};

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

function normalizeTargetLang(value: unknown): string {
  if (typeof value !== 'string') {
    return defaultExtensionSettings.targetLang;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh-cht' || normalized === 'zh_tw' || normalized === 'zh-tw' || normalized === 'zh-hant') {
    return 'zh-CHT';
  }
  if (normalized === 'zh-chs' || normalized === 'zh_cn' || normalized === 'zh-cn' || normalized === 'zh' || normalized === 'zh-hans') {
    return 'zh-CHS';
  }
  return defaultExtensionSettings.targetLang;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== 'object') {
    return { ...defaultExtensionSettings };
  }
  const raw = value as Record<string, unknown>;
  const legacyTranslator = raw.translator;
  const translator = legacyTranslator === 'llm' ? 'llm' : 'google_web';
  const legacyBaseUrl = typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl.trim() : '';
  const providerFromBaseUrl = detectBuiltInProviderByBaseUrl(legacyBaseUrl);
  const provider = isLlmProvider(raw.llmProvider)
    ? raw.llmProvider
    : providerFromBaseUrl
      ? providerFromBaseUrl
      : defaultExtensionSettings.llmProvider;

  const modelFromLegacy = typeof raw.llmModel === 'string' ? raw.llmModel.trim() : '';
  const modelCustomInput = typeof raw.llmModelCustom === 'string' ? raw.llmModelCustom.trim() : '';
  const modelPresetInput = typeof raw.llmModelPreset === 'string' ? raw.llmModelPreset.trim() : '';
  const modelToggleInput = typeof raw.llmUseCustomModel === 'boolean' ? raw.llmUseCustomModel : null;

  let llmModelPreset = '';
  let llmModelCustom = modelCustomInput;
  let llmUseCustomModel = false;
  if (isBuiltInProvider(provider)) {
    const modelSet = new Set(llmBuiltInProviderDefinitions[provider].models);
    if (modelSet.has(modelPresetInput)) {
      llmModelPreset = modelPresetInput;
    } else if (modelSet.has(modelFromLegacy)) {
      llmModelPreset = modelFromLegacy;
    } else {
      llmModelPreset = getDefaultModelPreset(provider);
    }
    llmUseCustomModel = modelToggleInput === true;
    if (llmUseCustomModel && !llmModelCustom && modelFromLegacy && !modelSet.has(modelFromLegacy)) {
      llmModelCustom = modelFromLegacy;
    }
  } else {
    llmModelPreset = '';
    llmUseCustomModel = true;
    if (!llmModelCustom && modelFromLegacy) {
      llmModelCustom = modelFromLegacy;
    }
  }

  const llmCustomBaseUrl = typeof raw.llmCustomBaseUrl === 'string' ? raw.llmCustomBaseUrl.trim() : '';
  const showElapsedTime = sanitizeBoolean(raw.showElapsedTime, defaultExtensionSettings.showElapsedTime);

  return {
    sourceLang: defaultExtensionSettings.sourceLang,
    targetLang: normalizeTargetLang(raw.targetLang),
    translator,
    llmProvider: provider,
    llmModelPreset,
    llmModelCustom,
    llmUseCustomModel,
    llmCustomBaseUrl: llmCustomBaseUrl || (provider === 'custom' ? legacyBaseUrl : ''),
    llmApiKey: typeof raw.llmApiKey === 'string' ? raw.llmApiKey.trim() : defaultExtensionSettings.llmApiKey,
    showElapsedTime,
    showStageTimingDetails: showElapsedTime
      ? sanitizeBoolean(raw.showStageTimingDetails, defaultExtensionSettings.showStageTimingDetails)
      : false,
  };
}

export function resolveLlmBaseUrl(settings: ExtensionSettings): string {
  if (settings.llmProvider === 'custom') {
    return settings.llmCustomBaseUrl.trim();
  }
  return llmBuiltInProviderDefinitions[settings.llmProvider].baseUrl;
}

export function resolveLlmModel(settings: ExtensionSettings): string {
  if (settings.llmProvider === 'custom') {
    return settings.llmModelCustom.trim();
  }
  if (!settings.llmUseCustomModel) {
    return settings.llmModelPreset.trim();
  }
  const customModel = settings.llmModelCustom.trim();
  return customModel;
}

export function validateSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') {
    return null;
  }

  const model = resolveLlmModel(settings);
  if (!model) {
    return 'LLM 模型不能为空';
  }
  if (!settings.llmApiKey.trim()) {
    return 'LLM API Key 不能为空';
  }

  if (settings.llmProvider === 'custom' && !settings.llmCustomBaseUrl.trim()) {
    return '自定义提供商 Base URL 不能为空';
  }

  return null;
}

export function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  return {
    sourceLang: 'ja',
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmBaseUrl: resolveLlmBaseUrl(settings),
    llmApiKey: settings.llmApiKey,
    llmModel: resolveLlmModel(settings),
  };
}
