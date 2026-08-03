import type { LlmAuthMode, LlmProvider } from './contracts';

export type BuiltInLlmProvider = Exclude<LlmProvider, 'custom'>;

export type LlmProviderDefinition = {
  label: string;
  webLabel: string;
  baseUrl: string;
  models: string[];
  defaultAuthMode: LlmAuthMode;
};

export const llmBuiltInProviderDefinitions: Record<
  BuiltInLlmProvider,
  LlmProviderDefinition
> = {
  deepseek: {
    label: 'DeepSeek', webLabel: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    defaultAuthMode: 'api_key',
  },
  gemini: {
    label: 'Nano Banana', webLabel: 'Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    models: ['gemini-3.1-flash-image', 'gemini-3-pro-image'],
    defaultAuthMode: 'gemini_app',
  },
  glm: {
    label: 'GLM (智谱)', webLabel: 'GLM / Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx'],
    defaultAuthMode: 'api_key',
  },
  kimi: {
    label: 'Kimi (月之暗面)', webLabel: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.6'],
    defaultAuthMode: 'api_key',
  },
  minimax: {
    label: 'MiniMax', webLabel: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
    defaultAuthMode: 'api_key',
  },
  mimo: {
    label: 'MiMo (小米)', webLabel: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    defaultAuthMode: 'api_key',
  },
  openai: {
    label: 'OpenAI', webLabel: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
    defaultAuthMode: 'openai_oauth',
  },
};

export const llmProviderOptions: Array<{
  value: LlmProvider;
  label: string;
}> = [
  ...Object.entries(llmBuiltInProviderDefinitions).map(([value, definition]) => ({
    value: value as BuiltInLlmProvider,
    label: definition.label,
  })),
  { value: 'custom', label: '自定义提供商' },
];

const modelPresetMigrations: Partial<Record<
  BuiltInLlmProvider,
  Record<string, string>
>> = {
  kimi: { 'kimi-k2.5': 'kimi-k2.6' },
  mimo: {
    'MiMo-V2.5-Pro': 'mimo-v2.5-pro',
    'MiMo-V2.5': 'mimo-v2.5',
  },
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return value === 'custom'
    || Object.hasOwn(llmBuiltInProviderDefinitions, String(value));
}

export function isBuiltInProvider(
  provider: LlmProvider,
): provider is BuiltInLlmProvider {
  return provider !== 'custom';
}

export function migrateBuiltInModelPreset(
  provider: LlmProvider,
  model: string,
): string {
  return isBuiltInProvider(provider)
    ? modelPresetMigrations[provider]?.[model] ?? model
    : model;
}

export function detectBuiltInProviderByBaseUrl(
  baseUrl: string,
): BuiltInLlmProvider | null {
  const normalized = baseUrl.trim().replace(/\/+$/u, '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'https://gemini.google.com') return 'gemini';
  if (normalized === 'https://api.mimo-v2.com/v1') return 'mimo';
  for (const [provider, definition] of Object.entries(
    llmBuiltInProviderDefinitions,
  )) {
    if (definition.baseUrl.replace(/\/+$/u, '').toLowerCase() === normalized) {
      return provider as BuiltInLlmProvider;
    }
  }
  return null;
}

export function getDefaultModelPreset(provider: BuiltInLlmProvider): string {
  return llmBuiltInProviderDefinitions[provider].models[0] ?? '';
}
