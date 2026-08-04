import type { DiagnosticLogEvent, DiagnosticLogTextExport } from '@shinobu/diagnostics';
import type { StageTiming } from '@shinobu/image-pipeline/benchmark';
import type { LlmAuthMode, LlmProvider } from '@shinobu/text-translation';
import { requireExtensionRuntime } from './extensionRuntime';
import { isLlmThinkingLevel } from '@shinobu/text-translation';
import type { LlmThinkingLevel } from '@shinobu/text-translation';
import { isReferrerPolicy } from './referrerPolicy';
import { toErrorMessage } from './utils';
import type {
  ExtensionControlCommand,
  ExtensionControlResult,
  WholeImageExecutionPreparation,
} from './extensionControl';

export type ExtensionControlRuntimeMessage = {
  type: 'mt:extension-control';
  command: ExtensionControlCommand;
};

export type DownloadImageMessage = {
  type: 'mt:download-image';
  imageUrl: string;
  referrerPolicy?: ReferrerPolicy;
};

export type CaptureVisibleTabMessage = {
  type: 'mt:capture-visible-tab';
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
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning_split?: boolean;
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive';
  };
};

export type LlmChatCompletionsProxyConfig = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  useCustomModel?: boolean;
  thinkingLevel?: LlmThinkingLevel;
};

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
  preparation: Extract<WholeImageExecutionPreparation, { provider: 'gemini-app' }>;
  diagnosticRunId?: string;
};

export type GeminiApiImageTranslateMessage = {
  type: 'mt:gemini-api-image-translate';
  image: ImageTranslateMessageImage;
  preparation: Extract<WholeImageExecutionPreparation, { provider: 'gemini-api' }>;
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
  | ExtensionControlRuntimeMessage
  | DownloadImageMessage
  | CaptureVisibleTabMessage
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
      type: 'mt:extension-control';
      result: ExtensionControlResult;
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

export type RuntimeErrorCode = 'llm_thinking_config' | 'extension_settings_conflict';

export type RuntimeErrorResponse = {
  ok: false;
  type: RuntimeMessage['type'];
  error: string;
  errorCode?: RuntimeErrorCode;
  status?: number;
  retryAfterMs?: number;
  retryable?: boolean;
  errorDetail?: RuntimeErrorDetail;
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
  if (
    error.errorCode === 'llm_thinking_config'
    || error.errorCode === 'extension_settings_conflict'
  ) {
    return error.errorCode;
  }
  return error.code === 'TRANSLATION_CONFIGURATION_CONFLICT'
    ? 'extension_settings_conflict'
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

function isExtensionControlRuntimeMessage(
  value: Record<string, unknown>,
): value is ExtensionControlRuntimeMessage {
  if (value.type !== 'mt:extension-control' || !isRecord(value.command)) {
    return false;
  }
  const command = value.command;
  if (command.kind === 'read' || command.kind === 'prepare-execution') return true;
  if (command.kind === 'replace-settings') {
    return isRecord(command.settings) && typeof command.expectedRevision === 'number';
  }
  if (command.kind === 'update-interface-preferences') {
    return isRecord(command.preferences);
  }
  if (command.kind === 'replace-api-key') {
    return isLlmProvider(command.provider) && typeof command.apiKey === 'string';
  }
  if (command.kind === 'clear-api-key') {
    return isLlmProvider(command.provider);
  }
  return command.kind === 'perform-access'
    && (command.target === 'openai-oauth' || command.target === 'gemini-app')
    && (
      command.action === 'refresh'
      || command.action === 'login'
      || command.action === 'logout'
    );
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
  if (
    value.type !== 'mt:gemini-app-image-translate'
    || !isRecord(value.image)
    || !isRecord(value.preparation)
  ) {
    return false;
  }
  const preparation = value.preparation;
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    preparation.provider === 'gemini-app' &&
    (preparation.model === 'nano_banana_2' || preparation.model === 'nano_banana_pro') &&
    typeof preparation.modelLabel === 'string' &&
    typeof preparation.prompt === 'string' &&
    (preparation.authMode === 'browser_session' || preparation.authMode === 'cookies_permission') &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string')
  );
}

function isGeminiApiImageTranslateMessage(value: Record<string, unknown>): value is GeminiApiImageTranslateMessage {
  if (
    value.type !== 'mt:gemini-api-image-translate'
    || !isRecord(value.image)
    || !isRecord(value.preparation)
  ) {
    return false;
  }
  const preparation = value.preparation;
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    preparation.provider === 'gemini-api' &&
    typeof preparation.model === 'string' &&
    typeof preparation.modelLabel === 'string' &&
    typeof preparation.prompt === 'string' &&
    typeof preparation.baseUrl === 'string' &&
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
    isExtensionControlRuntimeMessage(value) ||
    isDownloadImageMessage(value) ||
    type === 'mt:capture-visible-tab' ||
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

export function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const runtime = requireExtensionRuntime();
  return runtime.sendMessage<RuntimeResponse>(message).then((response) => {
      if (!response || typeof response !== 'object') {
        throw new Error('扩展消息返回为空');
      }
      return response;
  }).catch((error: unknown) => {
    throw new Error(`扩展通信失败: ${toErrorMessage(error)}`);
  });
}
