import type { LlmChatCompletionRequestBody } from "../../shared/messages";
import { openAiOAuthOriginator } from "../../shared/openaiOAuth";
import type { StoredOpenAiOAuthTokens } from "../../shared/openaiOAuth";
import {
  buildOpenAiResponsesRequest,
  extractOpenAiResponsesJsonText,
  extractOpenAiResponsesSseText,
} from "../../shared/openaiResponses";
import {
  createOpenAiRequestId,
  extractResponseError,
  getOpenAiOAuthInstallationId,
  getValidOpenAiOAuthTokens,
  readJsonResponse,
  refreshOpenAiOAuthTokens,
} from "./oauthService";

export const openAiCodexResponsesEndpoint = "https://chatgpt.com/backend-api/codex/responses";

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

export async function proxyOpenAiChatCompletions(body: LlmChatCompletionRequestBody): Promise<unknown> {
  let tokens = await getValidOpenAiOAuthTokens();
  let response = await fetchOpenAiCodexResponses(body, tokens);
  if (response.status === 401) {
    tokens = await refreshOpenAiOAuthTokens(tokens);
    response = await fetchOpenAiCodexResponses(body, tokens);
  }

  if (!response.ok) {
    const data = await readJsonResponse(response);
    throw new Error(`OpenAI ChatGPT 请求失败: ${extractResponseError(data) ?? `HTTP ${response.status}`}`);
  }

  const content = await readOpenAiCodexResponsesText(response);
  if (!content) {
    throw new Error('OpenAI ChatGPT 响应为空');
  }
  return toChatCompletionsResponse(content, body.model);
}
