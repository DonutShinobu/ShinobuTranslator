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
  alibaba: {
    label: '阿里云百炼', webLabel: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'qwen3.8-flash', 'qwen3.7-plus', 'glm-5.2', 'kimi-k3', 'MiniMax-M2.5'],
    defaultAuthMode: 'api_key',
  },
  deepseek: {
    label: 'DeepSeek', webLabel: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
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
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx'],
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
    models: ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'],
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
    'MiMo-V2.5-Pro': 'mimo-v2.5-pro',
    'MiMo-V2.5': 'mimo-v2.5',
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
  if (isAlibabaBailianCompatibleBaseUrl(normalized)) return 'alibaba';
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

export function isAlibabaBailianCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    const isAlibabaHost = hostname === 'dashscope.aliyuncs.com'
      || hostname === 'dashscope-intl.aliyuncs.com'
      || hostname === 'dashscope-us.aliyuncs.com'
      || hostname.endsWith('.dashscope.aliyuncs.com')
      || hostname.endsWith('.maas.aliyuncs.com');
    return isAlibabaHost && /(?:^|\/)compatible-mode\/v1(?:\/|$)/u.test(url.pathname);
  } catch {
    return false;
  }
}

export function getDefaultModelPreset(provider: BuiltInLlmProvider): string {
  return llmBuiltInProviderDefinitions[provider].models[0] ?? '';
}
