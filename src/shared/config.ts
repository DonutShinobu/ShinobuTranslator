import type { PipelineConfig } from '../types';
import type { GeminiAppAuthMode, GeminiAppModel, ImageEngine } from '../types';

export const extensionSettingsStorageKey = 'mangaTranslate.settings';

export type LlmProvider = PipelineConfig['llmProvider'];
export type LlmAuthMode = PipelineConfig['llmAuthMode'];
export type BuiltInLlmProvider = Exclude<LlmProvider, 'custom'>;
export type LlmProviderProfile = {
  apiKey: string;
  authMode: LlmAuthMode;
  modelPreset: string;
  modelCustom: string;
  useCustomModel: boolean;
  customBaseUrl: string;
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
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  gemini: {
    label: 'Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    models: ['gemini-3.1-flash-image', 'gemini-3-pro-image'],
  },
  glm: {
    label: 'GLM (Z.AI)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx'],
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.6', 'kimi-k2.5'],
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  },
  mimo: {
    label: 'MiMo (小米)',
    baseUrl: 'https://api.mimo-v2.com/v1',
    models: ['MiMo-V2.5-Pro', 'MiMo-V2.5'],
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-nano'],
  },
};

export const llmProviderOptions: Array<{ value: LlmProvider; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'gemini', label: 'Nano Banana' },
  { value: 'glm', label: 'GLM (Z.AI)' },
  { value: 'kimi', label: 'Kimi (Moonshot)' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'mimo', label: 'MiMo (小米)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'custom', label: '自定义提供商' },
];

const builtInProviders = Object.keys(llmBuiltInProviderDefinitions) as BuiltInLlmProvider[];

function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    value === 'deepseek' ||
    value === 'gemini' ||
    value === 'glm' ||
    value === 'kimi' ||
    value === 'minimax' ||
    value === 'mimo' ||
    value === 'openai' ||
    value === 'custom'
  );
}

function isBuiltInProvider(provider: LlmProvider): provider is BuiltInLlmProvider {
  return provider !== 'custom';
}

function detectBuiltInProviderByBaseUrl(baseUrl: string): BuiltInLlmProvider | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'https://gemini.google.com') {
    return 'gemini';
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
      authMode: provider === 'openai' ? 'openai_oauth' : provider === 'gemini' ? 'gemini_app' : 'api_key',
      modelPreset: getDefaultModelPreset(provider),
      modelCustom: '',
      useCustomModel: false,
      customBaseUrl: '',
    };
  }
  return {
    apiKey: '',
    authMode: 'api_key',
    modelPreset: '',
    modelCustom: '',
    useCustomModel: true,
    customBaseUrl: '',
  };
}

function createDefaultLlmProfiles(): Record<LlmProvider, LlmProviderProfile> {
  return {
    deepseek: createDefaultProviderProfile('deepseek'),
    gemini: createDefaultProviderProfile('gemini'),
    glm: createDefaultProviderProfile('glm'),
    kimi: createDefaultProviderProfile('kimi'),
    minimax: createDefaultProviderProfile('minimax'),
    mimo: createDefaultProviderProfile('mimo'),
    openai: createDefaultProviderProfile('openai'),
    custom: createDefaultProviderProfile('custom'),
  };
}

export type OcrEngine = '48px' | 'paddleocr_v6_medium';
export type ProcessMode = 'translate' | 'erase' | 'original';

export const geminiAppModelOptions: Array<{ value: GeminiAppModel; label: string }> = [
  { value: 'nano_banana_2', label: 'Nano Banana 2' },
  { value: 'nano_banana_pro', label: 'Nano Banana Pro' },
];

export const defaultGeminiAppPromptTemplate = [
  '请使用 Nano Banana Pro 对这张漫画图片进行端到端翻译和嵌字。',
  '将所有原文翻译为{targetLang}，擦除原字，并在原位置嵌入自然的中文译文。',
  '保持原图画风、分镜、气泡、人物、背景、线稿和颜色不变。',
  '只输出完成后的译图，不要输出解释、前后对比或额外文字。',
].join('\n');

export const optimizedGeminiAppPromptTemplate = [
  '任务：把这张漫画/插画页面中的所有原文翻译为{targetLang}，擦除原字，并把译文自然嵌回原位置。',
  '严格限制：只修改台词文字/音效文字以及它们所在的气泡、标牌、字幕区域。',
  '不要改变人物、表情、姿势、服装、道具、背景、分镜、线条、色彩、构图、画布尺寸和阅读顺序。',
  '不要新增、删除、替换任何非文字内容。看不清的文字请保留原状或留空，不要猜测剧情、台词、人名或音效。',
  '译文要自然、简洁、适合漫画气泡，必要时自动换行排版。',
  '输出要求：只输出完成后的译图，不要解释、不要对比图、不要额外文字。',
].join('\n');

const previousOptimizedGeminiAppPromptTemplate = [
  '任务：把这张漫画/插画页面中的所有原文翻译为{targetLang}，擦除原字，并把译文自然嵌回原位置。',
  '严格限制：只修改文字以及文字所在的气泡、标牌、字幕区域。',
  '不要改变人物、表情、姿势、服装、道具、背景、分镜、线条、色彩、构图、画布尺寸和阅读顺序。',
  '不要新增、删除、替换任何非文字内容。看不清的文字请保留原状或留空，不要猜测剧情、台词、人名或音效。',
  '译文要自然、简洁、适合漫画气泡，必要时自动换行排版。',
  '输出要求：只输出完成后的译图，不要解释、不要对比图、不要额外文字。',
].join('\n');

export type ExtensionSettings = {
  sourceLang: string;
  targetLang: string;
  imageEngine: ImageEngine;
  geminiAppExperimentalEnabled: boolean;
  geminiAppModel: GeminiAppModel;
  geminiAppPromptTemplate: string;
  geminiAppAuthMode: GeminiAppAuthMode;
  translator: PipelineConfig['translator'];
  llmProvider: LlmProvider;
  llmProfiles: Record<LlmProvider, LlmProviderProfile>;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  stageTimingCardExpanded: boolean;
  showTypesetDebug: boolean;
  showEraseDebug: boolean;
  debugOptionsExpanded: boolean;
  ocrEngine: OcrEngine;
  processMode: ProcessMode;
  enableDebugLog: boolean;
};

export const defaultExtensionSettings: ExtensionSettings = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  imageEngine: 'local',
  geminiAppExperimentalEnabled: false,
  geminiAppModel: 'nano_banana_pro',
  geminiAppPromptTemplate: optimizedGeminiAppPromptTemplate,
  geminiAppAuthMode: 'cookies_permission',
  translator: 'google_web',
  llmProvider: 'deepseek',
  llmProfiles: createDefaultLlmProfiles(),
  showElapsedTime: false,
  showStageTimingDetails: false,
  stageTimingCardExpanded: true,
  showTypesetDebug: false,
  showEraseDebug: false,
  debugOptionsExpanded: false,
  ocrEngine: '48px',
  processMode: 'translate',
  enableDebugLog: false,
};

export function targetLanguageLabel(targetLang: string): string {
  return targetLang === 'zh-CHT' ? '繁体中文' : '简体中文';
}

export function buildGeminiImagePrompt(
  settings: Pick<ExtensionSettings, 'geminiAppPromptTemplate' | 'targetLang'>,
): string {
  return settings.geminiAppPromptTemplate.replace(/\{targetLang\}/g, targetLanguageLabel(settings.targetLang));
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

function normalizeOcrEngine(value: unknown): OcrEngine {
  if (value === 'paddleocr' || value === 'paddleocr_v6_small' || value === 'paddleocr_v6_medium') {
    return 'paddleocr_v6_medium';
  }
  return '48px';
}

function normalizeProcessMode(value: unknown): ProcessMode {
  if (value === 'erase') return 'erase';
  if (value === 'original') return 'original';
  return 'translate';
}

function normalizeImageEngine(): ImageEngine {
  return 'local';
}

function normalizeGeminiAppAuthMode(): GeminiAppAuthMode {
  return 'cookies_permission';
}

function normalizeGeminiAppModel(value: unknown): GeminiAppModel {
  if (value === 'nano_banana_2' || value === 'nano-banana-2' || value === 'gemini-3.1-flash-image') {
    return 'nano_banana_2';
  }
  if (value === 'nano_banana_pro' || value === 'nano-banana-pro' || value === 'gemini-3-pro-image') {
    return 'nano_banana_pro';
  }
  return defaultExtensionSettings.geminiAppModel;
}

export function getGeminiAppModelLabel(model: GeminiAppModel): string {
  return geminiAppModelOptions.find((option) => option.value === model)?.label ?? 'Nano Banana Pro';
}

export function resolveGeminiApiImageModel(model: GeminiAppModel): string {
  return model === 'nano_banana_2' ? 'gemini-3.1-flash-image' : 'gemini-3-pro-image';
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

function normalizeGeminiAppPromptTemplate(value: unknown): string {
  const normalized = normalizeProfileString(value, optimizedGeminiAppPromptTemplate);
  if (!normalized) {
    return optimizedGeminiAppPromptTemplate;
  }
  if (normalized === defaultGeminiAppPromptTemplate) {
    return optimizedGeminiAppPromptTemplate;
  }
  if (normalized === previousOptimizedGeminiAppPromptTemplate) {
    return optimizedGeminiAppPromptTemplate;
  }
  return normalized;
}

function normalizeAuthMode(provider: LlmProvider, value: unknown): LlmAuthMode {
  if (provider === 'openai') {
    return value === 'api_key' ? 'api_key' : 'openai_oauth';
  }
  if (provider === 'gemini') {
    return value === 'api_key' ? 'api_key' : 'gemini_app';
  }
  return 'api_key';
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
    llmAuthMode: unknown;
  } | null
): LlmProviderProfile {
  const defaults = createDefaultProviderProfile(provider);
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const apiKey = normalizeProfileString(raw?.apiKey, defaults.apiKey);
  let authMode = normalizeAuthMode(provider, raw?.authMode ?? legacy?.llmAuthMode ?? defaults.authMode);
  const modelPresetInput = normalizeProfileString(raw?.modelPreset, '');
  const modelCustomInput = normalizeProfileString(raw?.modelCustom, '');
  const useCustomModelInput = typeof raw?.useCustomModel === 'boolean' ? raw.useCustomModel : null;
  const customBaseUrlInput = normalizeProfileString(raw?.customBaseUrl, '');
  if (
    provider === 'gemini' &&
    authMode === 'api_key' &&
    !apiKey &&
    (modelPresetInput === 'nano-banana-2' ||
      modelPresetInput === 'nano-banana-pro' ||
      legacy?.modelPresetInput === 'nano-banana-2' ||
      legacy?.modelPresetInput === 'nano-banana-pro' ||
      legacy?.modelFromLegacy === 'nano-banana-2' ||
      legacy?.modelFromLegacy === 'nano-banana-pro')
  ) {
    authMode = 'gemini_app';
  }

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
      provider === 'gemini'
        ? false
        : useCustomModelInput === null ? (legacy?.modelToggleInput === true ? true : defaults.useCustomModel) : useCustomModelInput;
    let modelCustom = provider === 'gemini' ? '' : modelCustomInput || (legacy?.modelCustomInput ?? '');
    if (useCustomModel && !modelCustom && legacy?.modelFromLegacy && !modelSet.has(legacy.modelFromLegacy)) {
      modelCustom = legacy.modelFromLegacy;
    }

    return {
      apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
      authMode,
      modelPreset: candidatePreset,
      modelCustom,
      useCustomModel,
      customBaseUrl: '',
    };
  }

  return {
    apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
    authMode,
    modelPreset: '',
    modelCustom: modelCustomInput || (legacy?.modelCustomInput ?? legacy?.modelFromLegacy ?? defaults.modelCustom),
    useCustomModel: true,
    customBaseUrl: customBaseUrlInput || (legacy?.llmCustomBaseUrl ?? defaults.customBaseUrl),
  };
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== 'object') {
    return { ...defaultExtensionSettings };
  }
  const raw = value as Record<string, unknown>;
  const legacyTranslator = raw.translator;
  const legacyGeminiAppEnabled = raw.imageEngine === 'gemini_app' && raw.geminiAppExperimentalEnabled === true;
  const translator = legacyGeminiAppEnabled || legacyTranslator === 'llm' ? 'llm' : 'google_web';
  const legacyBaseUrl = typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl.trim() : '';
  const providerFromBaseUrl = detectBuiltInProviderByBaseUrl(legacyBaseUrl);
  const provider = raw.llmProvider === 'gemini_api'
    ? 'gemini'
    : isLlmProvider(raw.llmProvider)
      ? raw.llmProvider
      : legacyGeminiAppEnabled
        ? 'gemini'
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
    llmAuthMode: raw.llmAuthMode,
  };
  const rawProfiles = raw.llmProfiles && typeof raw.llmProfiles === 'object' ? (raw.llmProfiles as Record<string, unknown>) : {};
  const rawGeminiProfile = rawProfiles.gemini ?? rawProfiles.gemini_api;

  const llmProfiles: Record<LlmProvider, LlmProviderProfile> = {
    deepseek: normalizeProviderProfile('deepseek', rawProfiles.deepseek, provider === 'deepseek' ? legacy : null),
    gemini: normalizeProviderProfile('gemini', rawGeminiProfile, provider === 'gemini' ? legacy : null),
    glm: normalizeProviderProfile('glm', rawProfiles.glm, provider === 'glm' ? legacy : null),
    kimi: normalizeProviderProfile('kimi', rawProfiles.kimi, provider === 'kimi' ? legacy : null),
    minimax: normalizeProviderProfile('minimax', rawProfiles.minimax, provider === 'minimax' ? legacy : null),
    mimo: normalizeProviderProfile('mimo', rawProfiles.mimo, provider === 'mimo' ? legacy : null),
    openai: normalizeProviderProfile('openai', rawProfiles.openai, provider === 'openai' ? legacy : null),
    custom: normalizeProviderProfile('custom', rawProfiles.custom, provider === 'custom' ? legacy : null),
  };
  const showElapsedTime = sanitizeBoolean(raw.showElapsedTime, defaultExtensionSettings.showElapsedTime);
  const showTypesetDebug = sanitizeBoolean(raw.showTypesetDebug, defaultExtensionSettings.showTypesetDebug);
  const usesNanoBanana = usesNanoBananaImagePipeline({ translator, llmProvider: provider });
  const geminiAppExperimentalEnabled = sanitizeBoolean(
    raw.geminiAppExperimentalEnabled,
    defaultExtensionSettings.geminiAppExperimentalEnabled,
  );
  return {
    sourceLang: defaultExtensionSettings.sourceLang,
    targetLang: normalizeTargetLang(raw.targetLang),
    imageEngine: normalizeImageEngine(),
    geminiAppExperimentalEnabled,
    geminiAppModel: normalizeGeminiAppModel(raw.geminiAppModel),
    geminiAppPromptTemplate: normalizeGeminiAppPromptTemplate(raw.geminiAppPromptTemplate),
    geminiAppAuthMode: normalizeGeminiAppAuthMode(),
    translator,
    llmProvider: provider,
    llmProfiles,
    showElapsedTime,
    showStageTimingDetails:
      usesNanoBanana
        ? false
        : showElapsedTime
          ? sanitizeBoolean(raw.showStageTimingDetails, defaultExtensionSettings.showStageTimingDetails)
          : false,
    stageTimingCardExpanded: sanitizeBoolean(raw.stageTimingCardExpanded, defaultExtensionSettings.stageTimingCardExpanded),
    showTypesetDebug: usesNanoBanana ? false : showTypesetDebug,
    showEraseDebug: usesNanoBanana
      ? false
      : sanitizeBoolean(raw.showEraseDebug, defaultExtensionSettings.showEraseDebug),
    debugOptionsExpanded: sanitizeBoolean(raw.debugOptionsExpanded, defaultExtensionSettings.debugOptionsExpanded),
    ocrEngine: normalizeOcrEngine(raw.ocrEngine),
    processMode: normalizeProcessMode(raw.processMode),
    enableDebugLog: usesNanoBanana
      ? false
      : sanitizeBoolean(raw.enableDebugLog, defaultExtensionSettings.enableDebugLog),
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

export function requiresLlmApiKey(settings: ExtensionSettings): boolean {
  const profile = settings.llmProfiles[settings.llmProvider];
  return (
    !(settings.llmProvider === 'gemini' && profile.authMode === 'gemini_app') &&
    !(settings.llmProvider === 'openai' && profile.authMode === 'openai_oauth')
  );
}

export function usesNanoBananaImagePipeline(settings: Pick<ExtensionSettings, 'translator' | 'llmProvider'>): boolean {
  return settings.translator === 'llm' && settings.llmProvider === 'gemini';
}

export function usesGeminiAppImagePipeline(settings: Pick<ExtensionSettings, 'translator' | 'llmProvider' | 'llmProfiles'>): boolean {
  return usesNanoBananaImagePipeline(settings) && settings.llmProfiles.gemini.authMode === 'gemini_app';
}

export function usesGeminiApiImagePipeline(settings: Pick<ExtensionSettings, 'translator' | 'llmProvider' | 'llmProfiles'>): boolean {
  return usesNanoBananaImagePipeline(settings) && settings.llmProfiles.gemini.authMode === 'api_key';
}

export function validateSettings(settings: ExtensionSettings): string | null {
  if (usesNanoBananaImagePipeline(settings)) {
    if (!settings.geminiAppPromptTemplate.trim()) {
      return 'Nano Banana 提示词不能为空';
    }
    if (usesGeminiApiImagePipeline(settings)) {
      const profile = settings.llmProfiles[settings.llmProvider];
      if (!profile.apiKey.trim()) {
        return 'Nano Banana API Key 不能为空';
      }
    }
    return null;
  }

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
  if (requiresLlmApiKey(settings) && !profile.apiKey.trim()) {
    return 'LLM 模式需要填写 API Key';
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
    llmAuthMode: profile.authMode,
    llmBaseUrl: resolveLlmBaseUrl(settings),
    llmApiKey: profile.apiKey,
    llmModel: resolveLlmModel(settings),
    typesetDebug: settings.showTypesetDebug,
    eraseDebug: settings.showEraseDebug,
    collectDebugLog: settings.showTypesetDebug || settings.enableDebugLog,
    ocrEngine: settings.ocrEngine,
    processMode: settings.processMode,
  };
}
