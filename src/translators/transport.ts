import type {
  LlmChatCompletionRequestBody,
  LlmChatCompletionsProxyConfig,
} from '../shared/messages';
import { sendRuntimeMessage } from '../shared/messages';
import {
  adaptLlmThinkingChatCompletionRequest,
  isLlmThinkingConfigurationRejection,
} from '../shared/llmThinking';
import { googleWebTranslate } from './googleWeb';

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export type ChatCompletionTransportRequest = {
  body: LlmChatCompletionRequestBody;
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

export interface TextTranslationTransport {
  requestChatCompletion(
    request: ChatCompletionTransportRequest,
  ): Promise<ChatCompletionResponse>;
  translatePlain(request: PlainTranslationTransportRequest): Promise<string>;
}

export class TextTranslationTransportError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly responseText?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      responseText?: string;
    } = {},
  ) {
    super(message);
    this.name = 'TextTranslationTransportError';
    this.status = options.status;
    this.code = options.code;
    this.responseText = options.responseText;
  }
}

export type DirectTextTranslationTransportOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
};

const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response, retryIndex: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, at - Date.now()));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** retryIndex);
}

function extractErrorDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.error
    && typeof record.error === 'object'
    && typeof (record.error as Record<string, unknown>).message === 'string'
  ) {
    return (record.error as Record<string, string>).message;
  }
  for (const key of ['message', 'detail', 'error_description', 'error']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return null;
}

function parseResponseText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

export const extensionTextTranslationTransport: TextTranslationTransport = {
  async requestChatCompletion(request) {
    const response = await sendRuntimeMessage({
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

export function createDirectTextTranslationTransport(
  options: DirectTextTranslationTransportOptions = {},
): TextTranslationTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = Math.max(
    0,
    Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES),
  );
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

      const body = adaptLlmThinkingChatCompletionRequest(request.body, {
        provider: request.proxyConfig.provider,
        model: request.body.model,
        level: request.proxyConfig.thinkingLevel,
        useCustomModel: request.proxyConfig.useCustomModel === true,
      });
      let response: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: request.signal,
        });
        if (!isRetryableStatus(response.status) || attempt === maxRetries) break;
        const delayMs = retryDelayMs(response, attempt);
        await response.body?.cancel().catch(() => undefined);
        await sleep(delayMs, request.signal);
      }
      if (!response) {
        throw new TextTranslationTransportError('LLM 请求未能启动');
      }
      const responseText = await response.text();
      const parsed = parseResponseText(responseText);
      if (!response.ok) {
        const detail = extractErrorDetail(parsed);
        const thinkingRejected = isLlmThinkingConfigurationRejection({
          status: response.status,
          provider: request.proxyConfig.provider,
          model: request.body.model,
          useCustomModel: request.proxyConfig.useCustomModel === true,
          errorDetail: `${detail ?? ''}\n${responseText}`,
        });
        throw new TextTranslationTransportError(
          thinkingRejected
            ? `当前模型不支持所选思考设置: ${detail ?? `HTTP ${response.status}`}`
            : `LLM 翻译请求失败: ${detail ?? `HTTP ${response.status}`}`,
          {
            status: response.status,
            code: thinkingRejected ? 'llm_thinking_config' : undefined,
            responseText,
          },
        );
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new TextTranslationTransportError('LLM 响应解析失败', {
          status: response.status,
          responseText,
        });
      }
      return parsed as ChatCompletionResponse;
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
