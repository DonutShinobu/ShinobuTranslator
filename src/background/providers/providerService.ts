import {
  getGeminiAppModelLabel,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  validateSettings,
} from "../../shared/config";
import type { ExtensionSettings } from "../../shared/config";
import {
  classifyLlmFetchError,
  sanitizeDiagnosticUrl,
  toDiagnosticError,
} from "../../shared/diagnosticLog";
import type {
  LlmChatCompletionsProxyConfig,
  RuntimeMessage,
  RuntimeResponse,
} from "../../shared/messages";
import {
  toImageTranslateDiagnosticData,
  type DiagnosticLogStoreService,
} from "../diagnostics/logStore";
import { geminiAppUrl } from "../gemini/authService";
import { runGeminiApiImageTranslate } from "../geminiApiImageClient";
import {
  getGeminiAppRawResponse,
  runGeminiAppImageTranslate,
} from "../geminiAppClient";
import {
  LlmChatCompletionHttpError,
  LlmChatCompletionParseError,
  proxyApiKeyChatCompletions,
  resolveLlmChatCompletionsEndpoint,
} from "../llmProxy";
import {
  openAiCodexResponsesEndpoint,
  proxyOpenAiChatCompletions,
} from "../openai/responsesProxy";
import type {
  OpenAiOAuthService,
} from "../openai/oauthService";

export type ProviderService = {
  llm(message: LlmChatMessage): Promise<LlmChatResponse>;
  geminiAppImage(message: GeminiAppImageMessage): Promise<GeminiAppImageResponse>;
  geminiApiImage(message: GeminiApiImageMessage): Promise<GeminiApiImageResponse>;
};

type ProviderServiceDependencies = {
  getSettings(): Promise<ExtensionSettings>;
  diagnostics: Pick<DiagnosticLogStoreService, 'recordBackground'>;
  openAiOAuth: Pick<
    OpenAiOAuthService,
    'getInstallationId' | 'getValidTokens' | 'refreshTokens'
  >;
};

type LlmChatMessage = Extract<RuntimeMessage, { type: "mt:llm-chat-completions" }>;
type GeminiAppImageMessage = Extract<RuntimeMessage, { type: "mt:gemini-app-image-translate" }>;
type GeminiApiImageMessage = Extract<RuntimeMessage, { type: "mt:gemini-api-image-translate" }>;
type LlmChatResponse = Extract<RuntimeResponse, { ok: true; type: "mt:llm-chat-completions" }>;
type GeminiAppImageResponse = Extract<RuntimeResponse, { ok: true; type: "mt:gemini-app-image-translate" }>;
type GeminiApiImageResponse = Extract<RuntimeResponse, { ok: true; type: "mt:gemini-api-image-translate" }>;

function resolveLlmProxyConfig(
  settings: ExtensionSettings,
  proxyConfig: LlmChatCompletionsProxyConfig | undefined,
): LlmChatCompletionsProxyConfig {
  if (proxyConfig) {
    return proxyConfig;
  }
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    provider: settings.llmProvider,
    authMode: profile.authMode,
    baseUrl: resolveLlmBaseUrl(settings),
  };
}

function getLlmProxyEndpoint(proxyConfig: LlmChatCompletionsProxyConfig): string {
  if (proxyConfig.provider === 'openai' && proxyConfig.authMode === 'openai_oauth') {
    return openAiCodexResponsesEndpoint;
  }
  return resolveLlmChatCompletionsEndpoint(proxyConfig.baseUrl);
}

function getLlmProxyErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof LlmChatCompletionHttpError) {
    return {
      status: error.status,
      statusText: error.statusText,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  if (error instanceof LlmChatCompletionParseError) {
    return {
      status: error.status,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  return {};
}

async function handleLlmChatCompletions(
  message: LlmChatMessage,
  dependencies: ProviderServiceDependencies,
): Promise<LlmChatResponse> {
  const settings = await dependencies.getSettings();
  const proxyConfig = resolveLlmProxyConfig(settings, message.proxyConfig);
  const startedAt = Date.now();
  const baseLogData = {
    provider: proxyConfig.provider,
    authMode: proxyConfig.authMode,
    endpoint: sanitizeDiagnosticUrl(getLlmProxyEndpoint(proxyConfig)),
    model: message.body.model,
    messageCount: message.body.messages.length,
    responseFormat: message.body.response_format?.type ?? 'default',
    requestBody: message.body,
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await dependencies.diagnostics.recordBackground(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'background/index.ts' },
    message: `${proxyConfig.provider} LLM 代理请求开始`,
    data: baseLogData,
  });
  try {
    const data = proxyConfig.provider === 'openai' && proxyConfig.authMode === 'openai_oauth'
      ? await proxyOpenAiChatCompletions(
        message.body,
        proxyConfig,
        dependencies.openAiOAuth,
      )
      : await proxyApiKeyChatCompletions(settings, proxyConfig, message.body);
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'background/index.ts' },
      message: `${proxyConfig.provider} LLM 代理请求完成`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        responseData: data,
      },
    });
    return {
      ok: true,
      type: 'mt:llm-chat-completions',
      data,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(
      error,
      error instanceof LlmChatCompletionHttpError ? error.status : undefined,
    );
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'background/index.ts' },
      message: `${proxyConfig.provider} LLM 代理请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
        ...getLlmProxyErrorData(error),
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

async function handleGeminiAppImageTranslate(
  message: GeminiAppImageMessage,
  dependencies: ProviderServiceDependencies,
): Promise<GeminiAppImageResponse> {
  const settings = await dependencies.getSettings();
  const validationError = usesGeminiAppImagePipeline(settings)
    ? validateSettings(settings)
    : '请先在扩展弹窗中选择“大模型”，将 LLM 提供商设为 Nano Banana，并选择 Gemini 登录认证';
  if (validationError) {
    throw new Error(validationError);
  }
  const startedAt = Date.now();
  const baseLogData = {
    provider: 'gemini',
    authMode: 'gemini_app',
    endpoint: sanitizeDiagnosticUrl(geminiAppUrl),
    modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
    image: toImageTranslateDiagnosticData(message.image),
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await dependencies.diagnostics.recordBackground(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'geminiAppClient.ts' },
    message: 'Gemini App 全图翻译请求开始',
    data: baseLogData,
  });
  try {
    const translated = await runGeminiAppImageTranslate({
      imageBase64: message.image.base64,
      contentType: message.image.contentType,
      filename: message.image.filename,
      settings,
    });
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiAppClient.ts' },
      message: 'Gemini App 全图翻译请求完成',
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        output: {
          contentType: translated.contentType,
          base64Length: translated.base64.length,
        },
        metadata: {
          ...translated.metadata,
          imageUrl: translated.metadata.imageUrl ? sanitizeDiagnosticUrl(translated.metadata.imageUrl) : undefined,
        },
      },
    });
    return {
      ok: true,
      type: 'mt:gemini-app-image-translate',
      ...translated,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(error);
    const rawResponse = getGeminiAppRawResponse(error);
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiAppClient.ts' },
      message: `Gemini App 全图翻译请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
        rawResponse: rawResponse ?? undefined,
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

async function handleGeminiApiImageTranslate(
  message: GeminiApiImageMessage,
  dependencies: ProviderServiceDependencies,
): Promise<GeminiApiImageResponse> {
  const settings = await dependencies.getSettings();
  const validationError = usesGeminiApiImagePipeline(settings)
    ? validateSettings(settings)
    : '请先在扩展弹窗中选择“大模型”，将 LLM 提供商设为 Nano Banana，并选择 API Key 认证';
  if (validationError) {
    throw new Error(validationError);
  }
  const startedAt = Date.now();
  const model = resolveGeminiApiImageModel(settings.geminiAppModel);
  const endpoint = `${resolveLlmBaseUrl(settings).replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:generateContent`;
  const baseLogData = {
    provider: 'gemini',
    authMode: 'api_key',
    endpoint: sanitizeDiagnosticUrl(endpoint),
    model,
    modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
    image: toImageTranslateDiagnosticData(message.image),
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await dependencies.diagnostics.recordBackground(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'geminiApiImageClient.ts' },
    message: 'Gemini API 全图翻译请求开始',
    data: baseLogData,
  });
  try {
    const translated = await runGeminiApiImageTranslate({
      imageBase64: message.image.base64,
      contentType: message.image.contentType,
      filename: message.image.filename,
      settings,
    });
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiApiImageClient.ts' },
      message: 'Gemini API 全图翻译请求完成',
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        output: {
          contentType: translated.contentType,
          base64Length: translated.base64.length,
        },
        metadata: translated.metadata,
      },
    });
    return {
      ok: true,
      type: 'mt:gemini-api-image-translate',
      ...translated,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(error);
    await dependencies.diagnostics.recordBackground(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiApiImageClient.ts' },
      message: `Gemini API 全图翻译请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

export function createProviderService(
  dependencies: ProviderServiceDependencies,
): ProviderService {
  return {
    llm: (message) => handleLlmChatCompletions(message, dependencies),
    geminiAppImage: (message) => handleGeminiAppImageTranslate(
      message,
      dependencies,
    ),
    geminiApiImage: (message) => handleGeminiApiImageTranslate(
      message,
      dependencies,
    ),
  };
}
