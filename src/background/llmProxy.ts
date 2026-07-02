import { resolveLlmBaseUrl } from '../shared/config';
import type { ExtensionSettings } from '../shared/config';
import type { LlmChatCompletionRequestBody } from '../shared/messages';

export class LlmChatCompletionHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly responseText: string;

  constructor(status: number, statusText: string, contentType: string, responseText: string, detail: string | null) {
    super(`LLM 翻译请求失败: ${detail ?? `HTTP ${status}`}`);
    this.name = 'LlmChatCompletionHttpError';
    this.status = status;
    this.statusText = statusText;
    this.contentType = contentType;
    this.responseText = responseText;
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

export function resolveLlmChatCompletionsEndpoint(settings: ExtensionSettings): string {
  return `${resolveLlmBaseUrl(settings).replace(/\/+$/u, '')}/chat/completions`;
}

export async function proxyApiKeyChatCompletions(
  settings: ExtensionSettings,
  body: LlmChatCompletionRequestBody,
): Promise<unknown> {
  if (settings.llmProvider === 'gemini') {
    throw new Error('Nano Banana 使用端到端译图流程，不支持 OCR 文本翻译流程');
  }

  const profile = settings.llmProfiles[settings.llmProvider];
  if (profile.authMode !== 'api_key') {
    throw new Error('当前 LLM 认证方式不支持 API Key 请求');
  }

  const apiKey = profile.apiKey.trim();
  if (!apiKey) {
    throw new Error('LLM 模式需要填写 API Key');
  }

  const endpoint = resolveLlmChatCompletionsEndpoint(settings);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    const detail = extractApiErrorMessage(parseMaybeJson(responseText));
    throw new LlmChatCompletionHttpError(response.status, response.statusText, contentType, responseText, detail);
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new LlmChatCompletionParseError(response.status, contentType, responseText);
  }
}
