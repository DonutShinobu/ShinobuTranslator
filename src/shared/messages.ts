import type { ExtensionSettings } from './config';
import type { OpenAiOAuthStatusInfo } from './openaiOAuth';
import type { StageTiming } from '../types';
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

export type CaptureVisibleTabMessage = {
  type: 'mt:capture-visible-tab';
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

export type GeminiAppAuthStatusInfo = {
  authenticated: boolean;
  pending?: boolean;
  error?: string;
};

export type GeminiAppAuthStatusMessage = {
  type: 'mt:gemini-app-auth-status';
};

export type GeminiAppAuthLoginMessage = {
  type: 'mt:gemini-app-auth-login';
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

export type GeminiAppImageTranslateMessage = {
  type: 'mt:gemini-app-image-translate';
  image: {
    base64: string;
    contentType: string;
    filename: string;
  };
};

export type GeminiAppImageTranslateMetadata = {
  modelLabel: string;
  imageUrl?: string;
  stageTimings: StageTiming[];
};

/** Sent from background to content script when user clicks "翻译图片" in context menu. */
export type ContextMenuTranslateMessage = {
  type: 'mt:context-menu-translate';
};

/** Sent from background to content script when user clicks "截图翻译" in context menu. */
export type StartScreenshotTranslateMessage = {
  type: 'mt:start-screenshot-translate';
};

/** Sent from background to content script when user presses the hover-target translation shortcut. */
export type ShortcutTranslateHoverMessage = {
  type: 'mt:shortcut-translate-hover';
};

export type RuntimeMessage =
  | GetSettingsMessage
  | SetSettingsMessage
  | DownloadImageMessage
  | CaptureVisibleTabMessage
  | OpenAiOAuthStatusMessage
  | OpenAiOAuthLoginMessage
  | OpenAiOAuthLogoutMessage
  | GeminiAppAuthStatusMessage
  | GeminiAppAuthLoginMessage
  | LlmChatCompletionsMessage
  | GeminiAppImageTranslateMessage
  | ContextMenuTranslateMessage
  | StartScreenshotTranslateMessage
  | ShortcutTranslateHoverMessage;

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
      type: 'mt:capture-visible-tab';
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
      type: 'mt:gemini-app-auth-status';
      status: GeminiAppAuthStatusInfo;
    }
  | {
      ok: true;
      type: 'mt:gemini-app-auth-login';
      status: GeminiAppAuthStatusInfo;
    }
  | {
      ok: true;
      type: 'mt:llm-chat-completions';
      data: unknown;
    }
  | {
      ok: true;
      type: 'mt:gemini-app-image-translate';
      base64: string;
      contentType: string;
      metadata: GeminiAppImageTranslateMetadata;
    }
  | {
      ok: true;
      type: 'mt:context-menu-translate';
    }
  | {
      ok: true;
      type: 'mt:start-screenshot-translate';
    }
  | {
      ok: true;
      type: 'mt:shortcut-translate-hover';
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

function isGeminiAppImageTranslateMessage(value: Record<string, unknown>): value is GeminiAppImageTranslateMessage {
  if (value.type !== 'mt:gemini-app-image-translate' || !isRecord(value.image)) {
    return false;
  }
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string'
  );
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
    type === 'mt:capture-visible-tab' ||
    type === 'mt:openai-oauth-status' ||
    type === 'mt:openai-oauth-login' ||
    type === 'mt:openai-oauth-logout' ||
    type === 'mt:gemini-app-auth-status' ||
    type === 'mt:gemini-app-auth-login' ||
    type === 'mt:context-menu-translate' ||
    type === 'mt:start-screenshot-translate' ||
    type === 'mt:shortcut-translate-hover' ||
    isGeminiAppImageTranslateMessage(value) ||
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
