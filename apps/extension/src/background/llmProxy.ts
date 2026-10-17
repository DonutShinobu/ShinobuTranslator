import type { ExtensionSettings } from '../shared/config';
import type {
  LlmChatCompletionRequestBody,
  LlmChatCompletionsProxyConfig,
  RuntimeErrorCode,
} from '../shared/messages';
import {
  adaptLlmThinkingChatCompletionRequest,
  isLlmThinkingConfigurationRejection,
} from '@shinobu/text-translation';
import { abortable, throwIfSignalAborted } from '../shared/abortable';

const MAX_LLM_CONCURRENCY = 3;
const LLM_CONCURRENCY_RECOVERY_SUCCESSES = 4;
const MAX_LLM_BACKOFF_MS = 8_000;
const LLM_RESPONSE_CACHE_LIMIT = 256;
const LLM_RESPONSE_CACHE_TTL_MS = 30 * 60 * 1_000;

type QueuedLlmRequest = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  removeCancellation: () => void;
};

type InFlightLlmRequest = {
  controller: AbortController;
  promise: Promise<unknown>;
  subscribers: number;
};

type CachedLlmResponse = {
  expiresAt: number;
  value: unknown;
};

const llmRequestQueue: QueuedLlmRequest[] = [];
const llmResponseCache = new Map<string, CachedLlmResponse>();
const llmInFlightRequests = new Map<string, InFlightLlmRequest>();
let activeLlmRequests = 0;
let llmConcurrencyLimit = MAX_LLM_CONCURRENCY;
let llmRecoverySuccesses = 0;
let llmBlockedUntil = 0;
let llmPumpTimer: ReturnType<typeof setTimeout> | null = null;

export class LlmChatCompletionHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly responseText: string;
  readonly errorCode?: RuntimeErrorCode;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    statusText: string,
    contentType: string,
    responseText: string,
    detail: string | null,
    errorCode?: RuntimeErrorCode,
    retryAfterMs?: number,
  ) {
    super(
      errorCode === 'llm_thinking_config'
        ? `当前模型不支持所选思考设置: ${detail ?? `HTTP ${status}`}`
        : `LLM 翻译请求失败: ${
          status === 413
            ? `HTTP 413${detail ? `: ${detail}` : ''}`
            : detail ?? `HTTP ${status}`
        }`,
    );
    this.name = 'LlmChatCompletionHttpError';
    this.status = status;
    this.statusText = statusText;
    this.contentType = contentType;
    this.responseText = responseText;
    this.errorCode = errorCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export class LlmChatCompletionParseError extends Error {
  readonly status: number;
  readonly contentType: string;
  readonly responseText: string;

  constructor(status: number, contentType: string, responseText: string) {
    super('LLM 响应解析失败');
    this.name = 'LlmChatCompletionParseError';
    this.status = status;
    this.contentType = contentType;
    this.responseText = responseText;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractApiErrorMessage(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const error = data.error;
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof data.message === 'string') {
    return data.message;
  }
  if (typeof data.detail === 'string') {
    return data.detail;
  }
  if (typeof data.error_description === 'string') {
    return data.error_description;
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  return null;
}

function parseMaybeJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  const retryAfter = value?.trim();
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readCachedLlmResponse(key: string): unknown | undefined {
  const cached = llmResponseCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    llmResponseCache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the bounded map behaves as an LRU cache.
  llmResponseCache.delete(key);
  llmResponseCache.set(key, cached);
  return cloneJsonValue(cached.value);
}

function cacheLlmResponse(key: string, value: unknown): void {
  llmResponseCache.delete(key);
  llmResponseCache.set(key, {
    expiresAt: Date.now() + LLM_RESPONSE_CACHE_TTL_MS,
    value: cloneJsonValue(value),
  });
  while (llmResponseCache.size > LLM_RESPONSE_CACHE_LIMIT) {
    const oldest = llmResponseCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    llmResponseCache.delete(oldest);
  }
}

function scheduleLlmPump(): void {
  if (llmPumpTimer) return;
  const delayMs = Math.max(0, llmBlockedUntil - Date.now());
  llmPumpTimer = setTimeout(() => {
    llmPumpTimer = null;
    pumpLlmRequests();
  }, delayMs);
}

function recordLlmRequestFailure(error: unknown): void {
  llmRecoverySuccesses = 0;
  if (!(error instanceof LlmChatCompletionHttpError)) return;
  if (error.status === 429) {
    llmConcurrencyLimit = 1;
  } else if (error.status >= 500) {
    llmConcurrencyLimit = Math.max(1, llmConcurrencyLimit - 1);
  } else {
    return;
  }
  const requestedBackoffMs = error.retryAfterMs ?? (error.status === 429 ? 1_000 : 500);
  llmBlockedUntil = Math.max(
    llmBlockedUntil,
    Date.now() + Math.min(MAX_LLM_BACKOFF_MS, requestedBackoffMs),
  );
}

function recordLlmRequestSuccess(): void {
  if (llmConcurrencyLimit >= MAX_LLM_CONCURRENCY) {
    llmRecoverySuccesses = 0;
    return;
  }
  llmRecoverySuccesses += 1;
  if (
    Date.now() >= llmBlockedUntil
    && llmRecoverySuccesses >= LLM_CONCURRENCY_RECOVERY_SUCCESSES
  ) {
    llmConcurrencyLimit += 1;
    llmRecoverySuccesses = 0;
  }
}

function pumpLlmRequests(): void {
  if (Date.now() < llmBlockedUntil) {
    scheduleLlmPump();
    return;
  }
  while (
    activeLlmRequests < llmConcurrencyLimit
    && llmRequestQueue.length > 0
  ) {
    const request = llmRequestQueue.shift()!;
    request.removeCancellation();
    activeLlmRequests += 1;
    void abortable(request.run, request.signal)
      .then((value) => {
        recordLlmRequestSuccess();
        request.resolve(value);
      })
      .catch((error: unknown) => {
        recordLlmRequestFailure(error);
        request.reject(error);
      })
      .finally(() => {
        activeLlmRequests = Math.max(0, activeLlmRequests - 1);
        pumpLlmRequests();
      });
  }
}

function scheduleLlmRequest<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cancel = (): void => {
      const index = llmRequestQueue.indexOf(request);
      if (index >= 0) llmRequestQueue.splice(index, 1);
      reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
    };
    const request: QueuedLlmRequest = {
      run,
      resolve: (value) => resolve(value as T),
      reject,
      signal,
      removeCancellation: () => signal?.removeEventListener('abort', cancel),
    };
    signal?.addEventListener('abort', cancel, { once: true });
    llmRequestQueue.push(request);
    pumpLlmRequests();
  });
}

export function resetLlmRequestOptimizationStateForTests(): void {
  if (llmPumpTimer) clearTimeout(llmPumpTimer);
  llmPumpTimer = null;
  llmRequestQueue.splice(0).forEach((request) => {
    request.removeCancellation();
    request.reject(new Error('LLM 请求优化状态已重置'));
  });
  llmResponseCache.clear();
  llmInFlightRequests.clear();
  activeLlmRequests = 0;
  llmConcurrencyLimit = MAX_LLM_CONCURRENCY;
  llmRecoverySuccesses = 0;
  llmBlockedUntil = 0;
}

export function getLlmRequestOptimizationSnapshotForTests(): {
  active: number;
  queued: number;
  concurrencyLimit: number;
  cacheSize: number;
} {
  return {
    active: activeLlmRequests,
    queued: llmRequestQueue.length,
    concurrencyLimit: llmConcurrencyLimit,
    cacheSize: llmResponseCache.size,
  };
}

export function resolveLlmChatCompletionsEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`;
}

export async function proxyApiKeyChatCompletions(
  settings: ExtensionSettings,
  proxyConfig: LlmChatCompletionsProxyConfig,
  body: LlmChatCompletionRequestBody,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfSignalAborted(signal);
  if (proxyConfig.provider === 'gemini') {
    throw new Error('Nano Banana 使用端到端译图流程，不支持 OCR 文本翻译流程');
  }

  if (proxyConfig.authMode !== 'api_key') {
    throw new Error('当前 LLM 认证方式不支持 API Key 请求');
  }

  const profile = settings.llmProfiles[proxyConfig.provider];
  const apiKey = profile.apiKey.trim();
  if (!apiKey) {
    throw new Error('LLM 模式需要填写 API Key');
  }

  const baseUrl = proxyConfig.baseUrl.trim();
  if (!baseUrl) {
    throw new Error('LLM Base URL 不能为空');
  }

  const endpoint = resolveLlmChatCompletionsEndpoint(baseUrl);
  const usesCustomModel =
    proxyConfig.provider === 'custom' ||
    (proxyConfig.useCustomModel ?? profile.useCustomModel);
  const requestBody = adaptLlmThinkingChatCompletionRequest(body, {
    provider: proxyConfig.provider,
    model: body.model,
    level: proxyConfig.thinkingLevel,
    useCustomModel: usesCustomModel,
    baseUrl,
  });
  const cacheKey = JSON.stringify([
    proxyConfig.provider,
    endpoint,
    requestBody,
  ]);
  const cached = readCachedLlmResponse(cacheKey);
  if (cached !== undefined) return cached;

  let inFlight = llmInFlightRequests.get(cacheKey);
  if (!inFlight || inFlight.controller.signal.aborted) {
    const controller = new AbortController();
    const entry: InFlightLlmRequest = { controller, subscribers: 0, promise: Promise.resolve() };
    const request = scheduleLlmRequest(async () => {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
      const responseText = await response.text();
      const contentType = response.headers.get('content-type') ?? '';

      if (!response.ok) {
        const detail = extractApiErrorMessage(parseMaybeJson(responseText));
        const errorCode = isLlmThinkingConfigurationRejection({
          status: response.status,
          provider: proxyConfig.provider,
          model: body.model,
          useCustomModel: usesCustomModel,
          baseUrl,
          errorDetail: `${detail ?? ''}\n${responseText}`,
        })
          ? 'llm_thinking_config'
          : undefined;
        throw new LlmChatCompletionHttpError(
          response.status,
          response.statusText,
          contentType,
          responseText,
          detail,
          errorCode,
          parseRetryAfterMs(response.headers.get('retry-after')),
        );
      }

      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        throw new LlmChatCompletionParseError(response.status, contentType, responseText);
      }
    }, controller.signal);
    entry.promise = request.then((value) => {
      throwIfSignalAborted(controller.signal);
      cacheLlmResponse(cacheKey, value);
      return value;
    }).finally(() => {
      if (llmInFlightRequests.get(cacheKey) === entry) llmInFlightRequests.delete(cacheKey);
    });
    // Cancellation can remove all subscribers before the fetch settles.
    void entry.promise.catch(() => undefined);
    llmInFlightRequests.set(cacheKey, entry);
    inFlight = entry;
  }
  const shared = inFlight;
  shared.subscribers += 1;
  try {
    const value = await abortable(() => shared.promise, signal);
    return cloneJsonValue(value);
  } finally {
    shared.subscribers -= 1;
    if (shared.subscribers === 0 && llmInFlightRequests.get(cacheKey) === shared) {
      llmInFlightRequests.delete(cacheKey);
      shared.controller.abort(new DOMException('请求已无等待者', 'AbortError'));
    }
  }
}
