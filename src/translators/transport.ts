import type {
  LlmChatCompletionRequestBody,
  LlmChatCompletionsProxyConfig,
  RuntimeMessageSender,
} from '../shared/messages';
import type {
  PipelineHostChatCompletionResponse,
  PipelineHostTranslationTransport,
} from '../../apps/extension/src/pipelineHost/contracts';
import {
  createDirectChatCompletionRequester,
  DirectChatCompletionError,
  type DirectChatCompletionRequesterOptions,
} from '@shinobu/browser-runtime';
import {
  adaptLlmThinkingChatCompletionRequest,
  isLlmThinkingConfigurationRejection,
} from '../shared/llmThinking';
import { googleWebTranslate } from './googleWeb';

export type ChatCompletionResponse = PipelineHostChatCompletionResponse;

export type ChatCompletionTransportRequest = {
  body: LlmChatCompletionRequestBody;
  providerBody?: LlmChatCompletionRequestBody;
  proxyConfig: LlmChatCompletionsProxyConfig;
  apiKey?: string;
  diagnosticRunId?: string;
  signal?: AbortSignal;
};

export type PlainTranslationTransportRequest = {
  text: string;
  from: string;
  to: string;
  signal?: AbortSignal;
};

export type TextTranslationTransport = PipelineHostTranslationTransport;

export class TextTranslationTransportError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly responseText?: string;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      responseText?: string;
      retryAfterMs?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'TextTranslationTransportError';
    this.status = options.status;
    this.code = options.code;
    this.responseText = options.responseText;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable;
  }
}

export type DirectTextTranslationTransportOptions =
  DirectChatCompletionRequesterOptions;

export function createExtensionTextTranslationTransport(
  sendMessage: RuntimeMessageSender,
): TextTranslationTransport {
  return {
    async requestChatCompletion(request) {
      const response = await sendMessage({
        type: 'mt:llm-chat-completions',
        body: request.body,
        proxyConfig: request.proxyConfig,
        diagnosticRunId: request.diagnosticRunId,
      });
      if (!response.ok || response.type !== 'mt:llm-chat-completions') {
        throw new TextTranslationTransportError(
          response.ok ? 'LLM 翻译请求失败' : response.error,
          {
            code: !response.ok ? response.errorCode : undefined,
            status: !response.ok ? response.status : undefined,
            retryAfterMs: !response.ok ? response.retryAfterMs : undefined,
            retryable: !response.ok ? response.retryable : undefined,
          },
        );
      }
      return response.data as ChatCompletionResponse;
    },

    translatePlain(request) {
      return googleWebTranslate(
        request.text,
        request.from,
        request.to,
        request.signal,
      );
    },
  };
}

export const unavailableTextTranslationTransport: TextTranslationTransport = {
  requestChatCompletion() {
    return Promise.reject(new Error('文本翻译 transport capability 未注入'));
  },
  translatePlain() {
    return Promise.reject(new Error('文本翻译 transport capability 未注入'));
  },
};

export function createDirectTextTranslationTransport(
  options: DirectTextTranslationTransportOptions = {},
): TextTranslationTransport {
  const requester = createDirectChatCompletionRequester(options);
  return {
    async requestChatCompletion(request) {
      if (request.proxyConfig.authMode !== 'api_key') {
        throw new TextTranslationTransportError('Web 版本当前仅支持 API Key 认证');
      }
      const apiKey = request.apiKey?.trim() ?? '';
      if (!apiKey) {
        throw new TextTranslationTransportError('LLM 模式需要填写 API Key');
      }
      const baseUrl = request.proxyConfig.baseUrl.trim().replace(/\/+$/u, '');
      if (!baseUrl) {
        throw new TextTranslationTransportError('LLM Base URL 不能为空');
      }

      const body = request.providerBody
        ?? adaptLlmThinkingChatCompletionRequest(request.body, {
          provider: request.proxyConfig.provider,
          model: request.body.model,
          level: request.proxyConfig.thinkingLevel,
          useCustomModel: request.proxyConfig.useCustomModel === true,
        });
      try {
        return await requester.request({
          endpoint: `${baseUrl}/chat/completions`,
          apiKey,
          body,
          signal: request.signal,
        }) as ChatCompletionResponse;
      } catch (error) {
        if (!(error instanceof DirectChatCompletionError)) throw error;
        const thinkingRejected = isLlmThinkingConfigurationRejection({
          status: error.status ?? 0,
          provider: request.proxyConfig.provider,
          model: request.body.model,
          useCustomModel: request.proxyConfig.useCustomModel === true,
          errorDetail: `${error.detail ?? ''}\n${error.responseText ?? ''}`,
        });
        throw new TextTranslationTransportError(
          thinkingRejected
            ? `当前模型不支持所选思考设置: ${
              error.detail ?? `HTTP ${error.status ?? 0}`
            }`
            : error.message,
          {
            status: error.status,
            code: thinkingRejected ? 'llm_thinking_config' : undefined,
            responseText: error.responseText,
            retryAfterMs: error.retryAfterMs,
            retryable: error.retryable,
          },
        );
      }
    },

    translatePlain(request) {
      return googleWebTranslate(
        request.text,
        request.from,
        request.to,
        request.signal,
      );
    },
  };
}
