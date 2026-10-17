import {
  createDirectChatCompletionRequester,
  DirectChatCompletionError,
  type DirectChatCompletionRequesterOptions,
} from '@shinobu/browser-runtime';
import type {
  ChatCompletionTransportRequest,
  ChatCompletionResponse,
  TextTranslationTransport,
} from '../contracts';
import {
  adaptLlmThinkingChatCompletionRequest,
  isLlmThinkingConfigurationRejection,
} from '../llmThinking';
import { googleWebTranslate } from './googleWeb';

export type {
  ChatCompletionResponse,
  ChatCompletionTransportRequest,
  PlainTranslationTransportRequest,
  TextTranslationTransport,
} from '../contracts';

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

export type TextTranslationCredential =
  | string
  | (() => string | Promise<string>);

export type DirectTextTranslationTransportOptions =
  DirectChatCompletionRequesterOptions & {
    apiKey: TextTranslationCredential;
  };

export function createTextTranslationTransport(
  requestChatCompletion: (
    request: ChatCompletionTransportRequest,
  ) => Promise<ChatCompletionResponse>,
): TextTranslationTransport {
  return {
    requestChatCompletion,
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

async function resolveApiKey(
  credential: TextTranslationCredential,
): Promise<string> {
  const value = typeof credential === 'function'
    ? await credential()
    : credential;
  return value.trim();
}

/**
 * Browser transport whose credential is captured as a capability. The key is
 * never placed in a translation request, pipeline config, record, or observer
 * event.
 */
export function createDirectTextTranslationTransport(
  options: DirectTextTranslationTransportOptions,
): TextTranslationTransport {
  const { apiKey: credential, ...requesterOptions } = options;
  const requester = createDirectChatCompletionRequester(requesterOptions);
  return {
    async requestChatCompletion(request) {
      if (request.proxyConfig.authMode !== 'api_key') {
        throw new TextTranslationTransportError('Web 版本当前仅支持 API Key 认证');
      }
      const apiKey = await resolveApiKey(credential);
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
