import type { PipelineConfig } from '../types';

export const extensionSettingsStorageKey = 'mangaTranslate.settings';

export type LlmProvider = PipelineConfig['llmProvider'];
export type BuiltInLlmProvider = Exclude<LlmProvider, 'custom'>;
export type LlmProviderProfile = {
  apiKey: string;
  modelPreset: string;
  modelCustom: string;
  useCustomModel: boolean;
  customBaseUrl: string;
  temperature: number;
};

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
    models: ['glm5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6', 'glm-4.5-airx'],
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

function createDefaultProviderProfile(provider: LlmProvider): LlmProviderProfile {
  if (isBuiltInProvider(provider)) {
    return {
      apiKey: '',
      modelPreset: getDefaultModelPreset(provider),
      modelCustom: '',
      useCustomModel: false,
      customBaseUrl: '',
      temperature: 1,
    };
  }
  return {
    apiKey: '',
    modelPreset: '',
    modelCustom: '',
    useCustomModel: true,
    customBaseUrl: '',
    temperature: 1,
  };
}

function createDefaultLlmProfiles(): Record<LlmProvider, LlmProviderProfile> {
  return {
    deepseek: createDefaultProviderProfile('deepseek'),
    glm: createDefaultProviderProfile('glm'),
    kimi: createDefaultProviderProfile('kimi'),
    minimax: createDefaultProviderProfile('minimax'),
    custom: createDefaultProviderProfile('custom'),
  };
}

export type ExtensionSettings = {
  sourceLang: string;
  targetLang: string;
  translator: PipelineConfig['translator'];
  llmProvider: LlmProvider;
  llmProfiles: Record<LlmProvider, LlmProviderProfile>;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  showTypesetDebug: boolean;
};

export const defaultExtensionSettings: ExtensionSettings = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'google_web',
  llmProvider: 'deepseek',
  llmProfiles: createDefaultLlmProfiles(),
  showElapsedTime: false,
  showStageTimingDetails: false,
  showTypesetDebug: false,
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

function normalizeProfileString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value.trim();
}

function normalizeTemperature(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(value, 2));
}

function normalizeProviderProfile(
  provider: LlmProvider,
  value: unknown,
  legacy: {
    modelFromLegacy: string;
    modelPresetInput: string;
    modelCustomInput: string;
    modelToggleInput: boolean | null;
    llmCustomBaseUrl: string;
    llmApiKey: string;
  } | null
): LlmProviderProfile {
  const defaults = createDefaultProviderProfile(provider);
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const apiKey = normalizeProfileString(raw?.apiKey, defaults.apiKey);
  const modelPresetInput = normalizeProfileString(raw?.modelPreset, '');
  const modelCustomInput = normalizeProfileString(raw?.modelCustom, '');
  const useCustomModelInput = typeof raw?.useCustomModel === 'boolean' ? raw.useCustomModel : null;
  const customBaseUrlInput = normalizeProfileString(raw?.customBaseUrl, '');
  const temperature = normalizeTemperature(raw?.temperature, defaults.temperature);

  if (isBuiltInProvider(provider)) {
    const modelSet = new Set(llmBuiltInProviderDefinitions[provider].models);
    const candidatePreset = modelSet.has(modelPresetInput)
      ? modelPresetInput
      : legacy && modelSet.has(legacy.modelPresetInput)
        ? legacy.modelPresetInput
        : legacy && modelSet.has(legacy.modelFromLegacy)
          ? legacy.modelFromLegacy
          : defaults.modelPreset;

    const useCustomModel =
      useCustomModelInput === null ? (legacy?.modelToggleInput === true ? true : defaults.useCustomModel) : useCustomModelInput;
    let modelCustom = modelCustomInput || (legacy?.modelCustomInput ?? '');
    if (useCustomModel && !modelCustom && legacy?.modelFromLegacy && !modelSet.has(legacy.modelFromLegacy)) {
      modelCustom = legacy.modelFromLegacy;
    }

    return {
      apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
      modelPreset: candidatePreset,
      modelCustom,
      useCustomModel,
      customBaseUrl: '',
      temperature,
    };
  }

  return {
    apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
    modelPreset: '',
    modelCustom: modelCustomInput || (legacy?.modelCustomInput ?? legacy?.modelFromLegacy ?? defaults.modelCustom),
    useCustomModel: true,
    customBaseUrl: customBaseUrlInput || (legacy?.llmCustomBaseUrl ?? defaults.customBaseUrl),
    temperature,
  };
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

  const legacy = {
    modelFromLegacy: typeof raw.llmModel === 'string' ? raw.llmModel.trim() : '',
    modelCustomInput: typeof raw.llmModelCustom === 'string' ? raw.llmModelCustom.trim() : '',
    modelPresetInput: typeof raw.llmModelPreset === 'string' ? raw.llmModelPreset.trim() : '',
    modelToggleInput: typeof raw.llmUseCustomModel === 'boolean' ? raw.llmUseCustomModel : null,
    llmCustomBaseUrl: typeof raw.llmCustomBaseUrl === 'string' ? raw.llmCustomBaseUrl.trim() : '',
    llmApiKey: typeof raw.llmApiKey === 'string' ? raw.llmApiKey.trim() : defaultExtensionSettings.llmProfiles[provider].apiKey,
  };
  const rawProfiles = raw.llmProfiles && typeof raw.llmProfiles === 'object' ? (raw.llmProfiles as Record<string, unknown>) : {};

  const llmProfiles: Record<LlmProvider, LlmProviderProfile> = {
    deepseek: normalizeProviderProfile('deepseek', rawProfiles.deepseek, provider === 'deepseek' ? legacy : null),
    glm: normalizeProviderProfile('glm', rawProfiles.glm, provider === 'glm' ? legacy : null),
    kimi: normalizeProviderProfile('kimi', rawProfiles.kimi, provider === 'kimi' ? legacy : null),
    minimax: normalizeProviderProfile('minimax', rawProfiles.minimax, provider === 'minimax' ? legacy : null),
    custom: normalizeProviderProfile('custom', rawProfiles.custom, provider === 'custom' ? legacy : null),
  };
  const showElapsedTime = sanitizeBoolean(raw.showElapsedTime, defaultExtensionSettings.showElapsedTime);
  const showTypesetDebug = sanitizeBoolean(raw.showTypesetDebug, defaultExtensionSettings.showTypesetDebug);
  return {
    sourceLang: defaultExtensionSettings.sourceLang,
    targetLang: normalizeTargetLang(raw.targetLang),
    translator,
    llmProvider: provider,
    llmProfiles,
    showElapsedTime,
    showStageTimingDetails: showElapsedTime
      ? sanitizeBoolean(raw.showStageTimingDetails, defaultExtensionSettings.showStageTimingDetails)
      : false,
    showTypesetDebug,
  };
}

export function resolveLlmBaseUrl(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.customBaseUrl.trim();
  }
  return llmBuiltInProviderDefinitions[settings.llmProvider].baseUrl;
}

export function resolveLlmModel(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.modelCustom.trim();
  }
  if (!profile.useCustomModel) {
    return profile.modelPreset.trim();
  }
  const customModel = profile.modelCustom.trim();
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

  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom' && !profile.customBaseUrl.trim()) {
    return '自定义提供商 Base URL 不能为空';
  }

  return null;
}

export function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    sourceLang: 'ja',
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmBaseUrl: resolveLlmBaseUrl(settings),
    llmApiKey: profile.apiKey,
    llmModel: resolveLlmModel(settings),
    llmTemperature: profile.temperature,
    typesetDebug: settings.showTypesetDebug,
  };
}
