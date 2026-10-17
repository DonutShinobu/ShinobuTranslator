import type {
  LlmChatCompletionRequestBody,
  LlmChatCompletionsProxyConfig,
} from "../../shared/messages";
import {
  adaptLlmThinkingChatCompletionRequest,
  isLlmThinkingConfigurationRejection,
} from '@shinobu/text-translation';
import { openAiOAuthOriginator } from '@shinobu/text-translation/openai';
import type { StoredOpenAiOAuthTokens } from '@shinobu/text-translation/openai';
import {
  buildOpenAiResponsesRequest,
  extractOpenAiResponsesJsonText,
  extractOpenAiResponsesSseText,
} from '@shinobu/text-translation/openai';
import {
  createOpenAiRequestId,
  extractResponseError,
  getOpenAiOAuthInstallationId,
  getValidOpenAiOAuthTokens,
  readJsonResponse,
  refreshOpenAiOAuthTokens,
} from "./oauthService";

export const openAiCodexResponsesEndpoint = "https://chatgpt.com/backend-api/codex/responses";

class OpenAiThinkingConfigError extends Error {
  readonly errorCode = 'llm_thinking_config' as const;

  constructor(detail: string) {
    super(`当前模型不支持所选思考设置: ${detail}`);
    this.name = 'OpenAiThinkingConfigError';
  }
}

async function fetchOpenAiCodexResponses(
  body: LlmChatCompletionRequestBody,
  tokens: StoredOpenAiOAuthTokens,
): Promise<Response> {
  if (!tokens.accountId) {
    throw new Error('OpenAI 登录缺少账号 ID，请退出后重新登录');
  }

  const installationId = await getOpenAiOAuthInstallationId();
  const sessionId = createOpenAiRequestId();
  const threadId = createOpenAiRequestId();
  const request = buildOpenAiResponsesRequest(body, {
    'x-codex-installation-id': installationId,
  });

  return fetch(openAiCodexResponsesEndpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
      originator: openAiOAuthOriginator,
      'chatgpt-account-id': tokens.accountId,
      'session-id': sessionId,
      'thread-id': threadId,
    },
    body: JSON.stringify(request),
  });
}

async function readOpenAiCodexResponsesText(response: Response): Promise<string | null> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream')) {
    return extractOpenAiResponsesSseText(text);
  }

  try {
    return extractOpenAiResponsesJsonText(JSON.parse(text) as unknown);
  } catch {
    return extractOpenAiResponsesSseText(text);
  }
}

function toChatCompletionsResponse(content: string, model: string): unknown {
  return {
    id: `shinobu-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

export async function proxyOpenAiChatCompletions(
  body: LlmChatCompletionRequestBody,
  proxyConfig: LlmChatCompletionsProxyConfig,
): Promise<unknown> {
  const requestBody = adaptLlmThinkingChatCompletionRequest(body, {
    provider: 'openai',
    model: body.model,
    level: proxyConfig.thinkingLevel,
    useCustomModel: proxyConfig.useCustomModel,
  });
  let tokens = await getValidOpenAiOAuthTokens();
  let response = await fetchOpenAiCodexResponses(requestBody, tokens);
  if (response.status === 401) {
    tokens = await refreshOpenAiOAuthTokens(tokens);
    response = await fetchOpenAiCodexResponses(requestBody, tokens);
  }

  if (!response.ok) {
    const data = await readJsonResponse(response);
    const responseDetail = extractResponseError(data);
    const detail = response.status === 413
      ? `HTTP 413${responseDetail ? `: ${responseDetail}` : ''}`
      : responseDetail ?? `HTTP ${response.status}`;
    if (isLlmThinkingConfigurationRejection({
      status: response.status,
      provider: 'openai',
      model: body.model,
      useCustomModel: proxyConfig.useCustomModel,
      errorDetail: `${detail}\n${JSON.stringify(data)}`,
    })) {
      throw new OpenAiThinkingConfigError(detail);
    }
    throw new Error(`OpenAI ChatGPT 请求失败: ${detail}`);
  }

  const content = await readOpenAiCodexResponsesText(response);
  if (!content) {
    throw new Error('OpenAI ChatGPT 响应为空');
  }
  return toChatCompletionsResponse(content, requestBody.model);
}
