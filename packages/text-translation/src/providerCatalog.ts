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
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultAuthMode: 'api_key',
  },
  gemini: {
    label: 'Nano Banana', webLabel: 'Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    models: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'],
    defaultAuthMode: 'gemini_app',
  },
  glm: {
    label: 'GLM (智谱)', webLabel: 'GLM / Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'],
    defaultAuthMode: 'api_key',
  },
  kimi: {
    label: 'Kimi (月之暗面)', webLabel: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    defaultAuthMode: 'api_key',
  },
  alibaba: {
    label: 'Qwen（阿里云百炼）', webLabel: 'Qwen（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.8-flash'],
    defaultAuthMode: 'api_key',
  },
  doubao: {
    label: 'Doubao（火山方舟）', webLabel: 'Doubao（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-evolving', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-turbo-260628'],
    defaultAuthMode: 'api_key',
  },
  minimax: {
    label: 'MiniMax', webLabel: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
    defaultAuthMode: 'api_key',
  },
  mimo: {
    label: 'MiMo (小米)', webLabel: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    defaultAuthMode: 'api_key',
  },
  openai: {
    label: 'OpenAI', webLabel: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
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
  deepseek: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
  kimi: { 'kimi-k2.5': 'kimi-k2.6' },
  mimo: {
    'MiMo-V2.5-Pro': 'mimo-v2.6-pro',
    'mimo-v2.5-pro': 'mimo-v2.6-pro',
    'MiMo-V2.5': 'mimo-v2.6-flash',
    'mimo-v2.5': 'mimo-v2.6-flash',
  },
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string'
    && (value === 'custom' || Object.hasOwn(llmBuiltInProviderDefinitions, value));
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
