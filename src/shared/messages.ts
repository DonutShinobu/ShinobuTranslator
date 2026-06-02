import type { ExtensionSettings } from './config';
import type { OpenAiOAuthStatusInfo } from './openaiOAuth';
import { requireChromeApi } from './chrome';
import { toErrorMessage } from './utils';

export type GetSettingsMessage = {
  type: 'mt:get-settings';
};

export type SetSettingsMessage = {
  type: 'mt:set-settings';
  settings: ExtensionSettings;
};

export type DownloadImageMessage = {
  type: 'mt:download-image';
  imageUrl: string;
};

export type OpenAiOAuthStatusMessage = {
  type: 'mt:openai-oauth-status';
};

export type OpenAiOAuthLoginMessage = {
  type: 'mt:openai-oauth-login';
};

export type OpenAiOAuthLogoutMessage = {
  type: 'mt:openai-oauth-logout';
};

export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmChatCompletionRequestBody = {
  model: string;
  messages: LlmChatMessage[];
  response_format?: {
    type: 'json_object' | 'text';
  };
};

export type LlmChatCompletionsMessage = {
  type: 'mt:llm-chat-completions';
  body: LlmChatCompletionRequestBody;
};

/** Sent from background to content script when user clicks "翻译图片" in context menu. */
export type ContextMenuTranslateMessage = {
  type: 'mt:context-menu-translate';
};

export type RuntimeMessage =
  | GetSettingsMessage
  | SetSettingsMessage
  | DownloadImageMessage
  | OpenAiOAuthStatusMessage
  | OpenAiOAuthLoginMessage
  | OpenAiOAuthLogoutMessage
  | LlmChatCompletionsMessage
  | ContextMenuTranslateMessage;

export type RuntimeSuccessResponse =
  | {
      ok: true;
      type: 'mt:get-settings';
      settings: ExtensionSettings;
    }
  | {
      ok: true;
      type: 'mt:set-settings';
      settings: ExtensionSettings;
    }
  | {
      ok: true;
      type: 'mt:download-image';
      base64: string;
      contentType: string;
      sourceUrl: string;
    }
  | {
      ok: true;
      type: 'mt:openai-oauth-status';
      status: OpenAiOAuthStatusInfo;
    }
  | {
      ok: true;
      type: 'mt:openai-oauth-login';
      status: OpenAiOAuthStatusInfo;
    }
  | {
      ok: true;
      type: 'mt:openai-oauth-logout';
      status: OpenAiOAuthStatusInfo;
    }
  | {
      ok: true;
      type: 'mt:llm-chat-completions';
      data: unknown;
    }

export type RuntimeErrorResponse = {
  ok: false;
  type: RuntimeMessage['type'];
  error: string;
};

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLlmChatCompletionsMessage(value: Record<string, unknown>): value is LlmChatCompletionsMessage {
  if (value.type !== 'mt:llm-chat-completions' || !isRecord(value.body)) {
    return false;
  }
  return typeof value.body.model === 'string' && Array.isArray(value.body.messages);
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  return (
    type === 'mt:get-settings' ||
    type === 'mt:set-settings' ||
    type === 'mt:download-image' ||
    type === 'mt:openai-oauth-status' ||
    type === 'mt:openai-oauth-login' ||
    type === 'mt:openai-oauth-logout' ||
    isLlmChatCompletionsMessage(value)
  );
}

export function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const chromeApi = requireChromeApi();
  if (!chromeApi.runtime?.sendMessage) {
    return Promise.reject(new Error('当前环境不支持 runtime.sendMessage'));
  }
  return new Promise<RuntimeResponse>((resolve, reject) => {
    chromeApi.runtime?.sendMessage?.(message, (response: unknown) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('扩展消息返回为空'));
        return;
      }
      resolve(response as RuntimeResponse);
    });
  }).catch((error: unknown) => {
    throw new Error(`扩展通信失败: ${toErrorMessage(error)}`);
  });
}
