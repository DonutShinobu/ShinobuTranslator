import { describe, expect, it } from 'vitest';

import {
  adaptLlmThinkingChatCompletionRequest,
  createDefaultLlmThinkingByModel,
  getLlmThinkingCapability,
  getLlmThinkingControl,
  llmThinkingCapabilityRegistry,
  normalizeLlmThinkingByModel,
} from '../../src/shared/llmThinking';
import { llmBuiltInProviderDefinitions } from '../../src/shared/config';

describe('built-in LLM thinking capabilities', () => {
  it('matches the official-verified capability matrix for every built-in text model', () => {
    expect(llmThinkingCapabilityRegistry).toEqual({
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
    });
  });

  it('derives toggle, slider, and fixed controls without exposing unsupported off states', () => {
    expect(getLlmThinkingControl('glm', 'glm-5.1')).toMatchObject({
      kind: 'toggle',
      options: [
        { value: 'off', label: '关闭' },
        { value: 'on', label: '开启' },
      ],
    });
    expect(getLlmThinkingControl('deepseek', 'deepseek-v4-pro')).toMatchObject({
      kind: 'slider',
      options: [
        { value: 'off', label: '关闭' },
        { value: 'high', label: 'High' },
        { value: 'max', label: 'Max' },
      ],
    });
    expect(getLlmThinkingControl('openai', 'gpt-5.5-pro')).toMatchObject({
      kind: 'slider',
      options: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'XHigh' },
      ],
    });
    expect(getLlmThinkingControl('kimi', 'kimi-k3')).toEqual({
      kind: 'fixed',
      options: [{ value: 'max', label: 'Max' }],
      notice: '该模型不支持关闭思考模式',
    });
    expect(getLlmThinkingCapability('gemini', 'gemini-3.1-flash-image')).toBeNull();
    expect(getLlmThinkingCapability('custom', 'any-model')).toBeNull();
  });

  it('requires every built-in text model to have one exact capability definition', () => {
    const catalogKeys = Object.entries(llmBuiltInProviderDefinitions)
      .flatMap(([provider, definition]) => (
        provider === 'gemini'
          ? []
          : definition.models.map((model) => `${provider}/${model}`)
      ))
      .sort();

    expect(Object.keys(llmThinkingCapabilityRegistry).sort()).toEqual(catalogKeys);
  });

  it('normalizes invalid saved levels to each model safe default without affecting other models', () => {
    expect(normalizeLlmThinkingByModel({
      'deepseek/deepseek-v4-flash': 'high',
      'deepseek/deepseek-v4-pro': 'invalid',
      'openai/gpt-5.5-pro': 'off',
    })).toMatchObject({
      'deepseek/deepseek-v4-flash': 'high',
      'deepseek/deepseek-v4-pro': 'off',
      'openai/gpt-5.5-pro': 'medium',
    });
    expect(createDefaultLlmThinkingByModel()).toMatchObject({
      'deepseek/deepseek-v4-flash': 'off',
      'kimi/kimi-k3': 'max',
      'minimax/MiniMax-M2.7': 'on',
      'openai/gpt-5.5-pro': 'medium',
    });
  });

  it('maps canonical levels to each provider exact Chat Completions fields', () => {
    const body = {
      model: 'placeholder',
      messages: [{ role: 'user' as const, content: 'translate' }],
      response_format: { type: 'json_object' as const },
    };

    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      level: 'off',
    })).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      level: 'max',
    })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'glm',
      model: 'glm-5.2',
      level: 'high',
    })).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'glm',
      model: 'glm-5.1',
      level: 'on',
    })).toMatchObject({
      thinking: { type: 'enabled' },
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'kimi',
      model: 'kimi-k3',
      level: 'max',
    })).toMatchObject({
      reasoning_effort: 'max',
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'kimi',
      model: 'kimi-k2.6',
      level: 'off',
    })).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'minimax',
      model: 'MiniMax-M3',
      level: 'on',
    })).toEqual({
      model: 'placeholder',
      messages: [{ role: 'user', content: 'translate' }],
      reasoning_split: true,
      thinking: { type: 'adaptive' },
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      level: 'on',
    })).toEqual({
      model: 'placeholder',
      messages: [{ role: 'user', content: 'translate' }],
      reasoning_split: true,
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'mimo',
      model: 'mimo-v2.5',
      level: 'off',
    })).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      level: 'off',
    })).toMatchObject({
      reasoning_effort: 'none',
    });
    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      level: 'max',
    })).toMatchObject({
      reasoning_effort: 'max',
    });
  });

  it('leaves custom-model requests untouched', () => {
    const body = {
      model: 'deepseek-custom',
      messages: [{ role: 'user' as const, content: 'translate' }],
      response_format: { type: 'json_object' as const },
    };

    expect(adaptLlmThinkingChatCompletionRequest(body, {
      provider: 'deepseek',
      model: 'deepseek-custom',
      level: undefined,
      useCustomModel: true,
    })).toEqual(body);
  });
});
