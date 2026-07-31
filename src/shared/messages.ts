import type { ExtensionSettings } from './config';
import type { DiagnosticLogEvent, DiagnosticLogTextExport } from './diagnosticLog';
import type { OpenAiOAuthStatusInfo } from './openaiOAuth';
import type { LlmAuthMode, LlmProvider, StageTiming } from '../types';
import type {
  RuntimeRequestClient,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  PipelineHostChatCompletionRequestBody,
  PipelineHostChatCompletionsProxyConfig,
  PipelineHostChatMessage,
} from '../../apps/extension/src/pipelineHost/contracts';
import { isLlmThinkingLevel } from './llmThinking';
import { isReferrerPolicy } from './referrerPolicy';
import { toErrorMessage } from './utils';
import { normalizeJsonValue } from './jsonValue';

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
  referrerPolicy?: ReferrerPolicy;
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

export type LlmChatMessage = PipelineHostChatMessage;

export type LlmChatCompletionRequestBody =
  PipelineHostChatCompletionRequestBody;

export type LlmChatCompletionsProxyConfig =
  PipelineHostChatCompletionsProxyConfig;

export type LlmChatCompletionsMessage = {
  type: 'mt:llm-chat-completions';
  body: LlmChatCompletionRequestBody;
  proxyConfig?: LlmChatCompletionsProxyConfig;
  diagnosticRunId?: string;
};

type ImageTranslateMessageImage = {
  base64: string;
  contentType: string;
  filename: string;
};

export type GeminiAppImageTranslateMessage = {
  type: 'mt:gemini-app-image-translate';
  image: ImageTranslateMessageImage;
  diagnosticRunId?: string;
};

export type GeminiApiImageTranslateMessage = {
  type: 'mt:gemini-api-image-translate';
  image: ImageTranslateMessageImage;
  diagnosticRunId?: string;
};

export type CloudImageTranslateMetadata = {
  modelLabel: string;
  imageUrl?: string;
  stageTimings: StageTiming[];
};

export type GeminiAppImageTranslateMetadata = CloudImageTranslateMetadata;

export type GeminiApiImageTranslateMetadata = CloudImageTranslateMetadata;

export type CloudImageTranslateSuccess = {
  base64: string;
  contentType: string;
  metadata: CloudImageTranslateMetadata;
};

export type CloudImageTranslateRequest = {
  image: {
    base64: string;
    contentType: string;
    filename: string;
  };
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

export type DiagnosticLogEventMessage = {
  type: 'mt:diagnostic-log-event';
  event: DiagnosticLogEvent;
};

export type DiagnosticLogExportMessage = {
  type: 'mt:diagnostic-log-export';
};

export type DiagnosticLogClearMessage = {
  type: 'mt:diagnostic-log-clear';
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
  | GeminiApiImageTranslateMessage
  | DiagnosticLogEventMessage
  | DiagnosticLogExportMessage
  | DiagnosticLogClearMessage
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
      type: 'mt:gemini-api-image-translate';
      base64: string;
      contentType: string;
      metadata: GeminiApiImageTranslateMetadata;
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
  | {
      ok: true;
      type: 'mt:diagnostic-log-event';
    }
  | {
      ok: true;
      type: 'mt:diagnostic-log-export';
      log: DiagnosticLogTextExport;
    }
  | {
      ok: true;
      type: 'mt:diagnostic-log-clear';
    }

export type RuntimeErrorDetail = {
  title: string;
  content: string;
};

export type RuntimeErrorCode = 'llm_thinking_config';

export type RuntimePermissionRequirement =
  | {
      kind: 'cookie-access';
    }
  | {
      kind: 'authentication-data-use';
    }
  | {
      kind: 'target-origin';
      origin: string;
    };

export type RuntimePermissionRequired = {
  status: 'permission-required';
  missing: readonly RuntimePermissionRequirement[];
};

export type RuntimeExtensionError = {
  kind: 'operation';
  capability: string;
  operation: string;
  code: string;
  retryable: boolean;
  diagnostic: Readonly<Record<string, unknown>>;
};

export type RuntimeErrorResponse = {
  ok: false;
  type: RuntimeMessage['type'];
  error: string;
  errorCode?: RuntimeErrorCode;
  status?: number;
  retryAfterMs?: number;
  retryable?: boolean;
  errorDetail?: RuntimeErrorDetail;
  permission?: RuntimePermissionRequired;
  extensionError?: RuntimeExtensionError;
};

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDownloadImageMessage(value: Record<string, unknown>): value is DownloadImageMessage {
  if (value.type !== 'mt:download-image' || typeof value.imageUrl !== 'string') {
    return false;
  }
  try {
    const imageUrl = new URL(value.imageUrl);
    if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') {
      return false;
    }
  } catch {
    return false;
  }
  return value.referrerPolicy === undefined || isReferrerPolicy(value.referrerPolicy);
}

export function getRuntimeErrorCode(error: unknown): RuntimeErrorCode | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return error.errorCode === 'llm_thinking_config'
    ? error.errorCode
    : undefined;
}

export function getRuntimeTransportMetadata(error: unknown): {
  status?: number;
  retryAfterMs?: number;
  retryable?: boolean;
} {
  if (!isRecord(error)) return {};
  const metadata: {
    status?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  } = {};
  if (typeof error.status === 'number' && Number.isFinite(error.status)) {
    metadata.status = error.status;
  }
  if (
    typeof error.retryAfterMs === 'number'
    && Number.isFinite(error.retryAfterMs)
    && error.retryAfterMs >= 0
  ) {
    metadata.retryAfterMs = error.retryAfterMs;
  }
  if (error.retryable === true || error instanceof TypeError) {
    metadata.retryable = true;
  }
  return metadata;
}

function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    value === 'deepseek' ||
    value === 'gemini' ||
    value === 'glm' ||
    value === 'kimi' ||
    value === 'minimax' ||
    value === 'mimo' ||
    value === 'openai' ||
    value === 'custom'
  );
}

function isLlmAuthMode(value: unknown): value is LlmAuthMode {
  return value === 'api_key' || value === 'openai_oauth' || value === 'gemini_app';
}

function isLlmChatCompletionsMessage(value: Record<string, unknown>): value is LlmChatCompletionsMessage {
  if (value.type !== 'mt:llm-chat-completions' || !isRecord(value.body)) {
    return false;
  }
  const proxyConfig = value.proxyConfig;
  if (
    proxyConfig !== undefined &&
    (!isRecord(proxyConfig) ||
      !isLlmProvider(proxyConfig.provider) ||
      !isLlmAuthMode(proxyConfig.authMode) ||
      typeof proxyConfig.baseUrl !== 'string' ||
      (proxyConfig.useCustomModel !== undefined && typeof proxyConfig.useCustomModel !== 'boolean') ||
      (proxyConfig.thinkingLevel !== undefined && !isLlmThinkingLevel(proxyConfig.thinkingLevel)))
  ) {
    return false;
  }
  return (
    typeof value.body.model === 'string' &&
    Array.isArray(value.body.messages) &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string')
  );
}

function isGeminiAppImageTranslateMessage(value: Record<string, unknown>): value is GeminiAppImageTranslateMessage {
  if (value.type !== 'mt:gemini-app-image-translate' || !isRecord(value.image)) {
    return false;
  }
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string')
  );
}

function isGeminiApiImageTranslateMessage(value: Record<string, unknown>): value is GeminiApiImageTranslateMessage {
  if (value.type !== 'mt:gemini-api-image-translate' || !isRecord(value.image)) {
    return false;
  }
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string')
  );
}

function isDiagnosticLogEventMessage(value: Record<string, unknown>): value is DiagnosticLogEventMessage {
  if (value.type !== 'mt:diagnostic-log-event' || !isRecord(value.event)) {
    return false;
  }
  const event = value.event;
  return (
    typeof event.id === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.level === 'string' &&
    typeof event.category === 'string' &&
    isRecord(event.source) &&
    typeof event.source.context === 'string' &&
    typeof event.message === 'string'
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
    isDownloadImageMessage(value) ||
    type === 'mt:capture-visible-tab' ||
    type === 'mt:openai-oauth-status' ||
    type === 'mt:openai-oauth-login' ||
    type === 'mt:openai-oauth-logout' ||
    type === 'mt:gemini-app-auth-status' ||
    type === 'mt:gemini-app-auth-login' ||
    type === 'mt:diagnostic-log-export' ||
    type === 'mt:diagnostic-log-clear' ||
    type === 'mt:context-menu-translate' ||
    type === 'mt:start-screenshot-translate' ||
    type === 'mt:shortcut-translate-hover' ||
    isGeminiAppImageTranslateMessage(value) ||
    isGeminiApiImageTranslateMessage(value) ||
    isDiagnosticLogEventMessage(value) ||
    isLlmChatCompletionsMessage(value)
  );
}

export type RuntimeMessageSender = (
  message: RuntimeMessage,
) => Promise<RuntimeResponse>;

export const unavailableRuntimeMessageSender: RuntimeMessageSender = async () => {
  throw new Error('扩展 request capability 未注入');
};

export function createRuntimeMessageSender(
  requests: RuntimeRequestClient,
): RuntimeMessageSender {
  return async (message) => {
    try {
      const result = await requests.request(normalizeJsonValue(message));
      if (result.status !== 'response' || !isRecord(result.value)) {
        throw new Error(
          result.status === 'unavailable'
            ? '扩展消息接收端不可用'
            : '扩展消息返回为空',
        );
      }
      return result.value as RuntimeResponse;
    } catch (error) {
      throw new Error(`扩展通信失败: ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
  };
}
