import type { LlmProvider } from '../types';
import type { LlmChatCompletionRequestBody } from './messages';

export type LlmThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LlmThinkingCapability = {
  levels: LlmThinkingLevel[];
  defaultLevel: LlmThinkingLevel;
};

export type LlmThinkingByModel = Record<string, LlmThinkingLevel>;

export type LlmThinkingRequestContext = {
  provider: LlmProvider;
  model: string;
  level: LlmThinkingLevel | undefined;
  useCustomModel?: boolean;
};

export function isLlmThinkingLevel(value: unknown): value is LlmThinkingLevel {
  return (
    value === 'off'
    || value === 'on'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
  );
}

export function isLlmThinkingConfigurationErrorDetail(value: string): boolean {
  return /reasoning(?:[_\s.-]*effort)?|thinking|effort|思考|推理/iu.test(value);
}

export function isLlmThinkingConfigurationRejection(options: {
  status: number;
  provider: LlmProvider;
  model: string;
  useCustomModel?: boolean;
  errorDetail: string;
}): boolean {
  return (
    (options.status === 400 || options.status === 422)
    && !options.useCustomModel
    && getLlmThinkingCapability(options.provider, options.model) !== null
    && isLlmThinkingConfigurationErrorDetail(options.errorDetail)
  );
}

export type LlmThinkingControl = {
  kind: 'toggle' | 'slider' | 'fixed';
  options: Array<{
    value: LlmThinkingLevel;
    label: string;
  }>;
  notice?: string;
};

const thinkingLevelLabels: Record<LlmThinkingLevel, string> = {
  off: '关闭',
  on: '开启',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export const llmThinkingCapabilityRegistry: Record<string, LlmThinkingCapability> = {
  'deepseek/deepseek-v4-flash': {
    levels: ['off', 'high', 'max'],
    defaultLevel: 'off',
  },
  'deepseek/deepseek-v4-pro': {
    levels: ['off', 'high', 'max'],
    defaultLevel: 'off',
  },
  'glm/glm-5.2': {
    levels: ['off', 'high', 'max'],
    defaultLevel: 'off',
  },
  'glm/glm-5.1': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'glm/glm-5-turbo': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'glm/glm-5': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'glm/glm-4.7': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'glm/glm-4.7-flash': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'glm/glm-4.7-flashx': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'kimi/kimi-k3': {
    levels: ['max'],
    defaultLevel: 'max',
  },
  'kimi/kimi-k2.6': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'minimax/MiniMax-M3': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'minimax/MiniMax-M2.7': {
    levels: ['on'],
    defaultLevel: 'on',
  },
  'minimax/MiniMax-M2.7-highspeed': {
    levels: ['on'],
    defaultLevel: 'on',
  },
  'minimax/MiniMax-M2.5': {
    levels: ['on'],
    defaultLevel: 'on',
  },
  'minimax/MiniMax-M2.5-highspeed': {
    levels: ['on'],
    defaultLevel: 'on',
  },
  'mimo/mimo-v2.5-pro': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'mimo/mimo-v2.5': {
    levels: ['off', 'on'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.6-luna': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.6-terra': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.6-sol': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.5-pro': {
    levels: ['medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
  },
  'openai/gpt-5.5': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.4': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.4-mini': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'off',
  },
  'openai/gpt-5.4-nano': {
    levels: ['off', 'low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'off',
  },
};

export function llmThinkingCapabilityKey(provider: LlmProvider, model: string): string {
  return `${provider}/${model}`;
}

export function getLlmThinkingCapability(
  provider: LlmProvider,
  model: string,
): LlmThinkingCapability | null {
  return llmThinkingCapabilityRegistry[llmThinkingCapabilityKey(provider, model)] ?? null;
}

export function getLlmThinkingControl(provider: LlmProvider, model: string): LlmThinkingControl | null {
  const capability = getLlmThinkingCapability(provider, model);
  if (!capability) {
    return null;
  }

  const options = capability.levels.map((level) => ({
    value: level,
    label: thinkingLevelLabels[level],
  }));
  if (options.length === 1) {
    return {
      kind: 'fixed',
      options,
      notice: '该模型不支持关闭思考模式',
    };
  }
  if (capability.levels.length === 2 && capability.levels[0] === 'off' && capability.levels[1] === 'on') {
    return {
      kind: 'toggle',
      options,
    };
  }
  return {
    kind: 'slider',
    options,
  };
}

export function createDefaultLlmThinkingByModel(): LlmThinkingByModel {
  return Object.fromEntries(
    Object.entries(llmThinkingCapabilityRegistry).map(([key, capability]) => [
      key,
      capability.defaultLevel,
    ]),
  );
}

export function normalizeLlmThinkingByModel(value: unknown): LlmThinkingByModel {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries(llmThinkingCapabilityRegistry).map(([key, capability]) => {
      const candidate = raw[key];
      const normalized = typeof candidate === 'string'
        && capability.levels.includes(candidate as LlmThinkingLevel)
        ? candidate as LlmThinkingLevel
        : capability.defaultLevel;
      return [key, normalized];
    }),
  );
}

export function resolveLlmThinkingLevel(
  values: LlmThinkingByModel,
  provider: LlmProvider,
  model: string,
): LlmThinkingLevel | undefined {
  const capability = getLlmThinkingCapability(provider, model);
  if (!capability) {
    return undefined;
  }
  const candidate = values[llmThinkingCapabilityKey(provider, model)];
  return candidate && capability.levels.includes(candidate)
    ? candidate
    : capability.defaultLevel;
}

export function adaptLlmThinkingChatCompletionRequest(
  body: LlmChatCompletionRequestBody,
  context: LlmThinkingRequestContext,
): LlmChatCompletionRequestBody {
  if (context.provider === 'custom' || context.useCustomModel) {
    return { ...body };
  }

  const capability = getLlmThinkingCapability(context.provider, context.model);
  if (!capability) {
    return { ...body };
  }
  const level = context.level && capability.levels.includes(context.level)
    ? context.level
    : capability.defaultLevel;
  const request: LlmChatCompletionRequestBody = { ...body };
  delete request.reasoning_effort;
  delete request.reasoning_split;
  delete request.thinking;

  if (context.provider === 'minimax') {
    delete request.response_format;
    request.reasoning_split = true;
    if (context.model === 'MiniMax-M3') {
      request.thinking = {
        type: level === 'off' ? 'disabled' : 'adaptive',
      };
    }
    return request;
  }

  if (context.provider === 'openai') {
    if (level === 'on') {
      throw new Error(`OpenAI 模型 ${context.model} 的思考档位定义无效`);
    }
    request.reasoning_effort = level === 'off' ? 'none' : level;
    return request;
  }

  if (context.provider === 'deepseek') {
    request.thinking = {
      type: level === 'off' ? 'disabled' : 'enabled',
    };
    if (level === 'high' || level === 'max') {
      request.reasoning_effort = level;
    }
    return request;
  }

  if (context.provider === 'glm') {
    request.thinking = {
      type: level === 'off' ? 'disabled' : 'enabled',
    };
    if (context.model === 'glm-5.2' && (level === 'high' || level === 'max')) {
      request.reasoning_effort = level;
    }
    return request;
  }

  if (context.provider === 'kimi') {
    if (context.model === 'kimi-k3') {
      request.reasoning_effort = 'max';
    } else {
      request.thinking = {
        type: level === 'off' ? 'disabled' : 'enabled',
      };
    }
    return request;
  }

  if (context.provider === 'mimo') {
    request.thinking = {
      type: level === 'off' ? 'disabled' : 'enabled',
    };
  }
  return request;
}
