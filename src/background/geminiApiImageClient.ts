import {
  buildGeminiImagePrompt,
  getGeminiAppModelLabel,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
} from '../shared/config';
import type { ExtensionSettings } from '../shared/config';
import type { CloudImageTranslateSuccess } from '../shared/messages';
import type { StageTiming } from '../types';
import type { GeminiAppModel } from '../types';
import { toErrorMessage } from '../shared/utils';

type GeminiApiImageTranslateOptions = {
  imageBase64: string;
  contentType: string;
  filename: string;
  settings: ExtensionSettings;
};

type GeminiApiGeneratedImage = {
  base64: string;
  contentType: string;
};

type GeminiApiErrorInfo = {
  code?: number;
  status?: string;
  message?: string;
};

const requestTimeoutMs = 420_000;
let geminiApiQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeContentType(value: unknown): string {
  return stringValue(value) ?? 'image/png';
}

function extractErrorInfo(data: unknown): GeminiApiErrorInfo | null {
  if (!isRecord(data) || !isRecord(data.error)) {
    return null;
  }
  return {
    code: numberValue(data.error.code),
    status: stringValue(data.error.status) ?? undefined,
    message: stringValue(data.error.message) ?? undefined,
  };
}

function extractPromptFeedbackError(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.promptFeedback)) {
    return null;
  }
  const blockReason = stringValue(data.promptFeedback.blockReason);
  const blockReasonMessage = stringValue(data.promptFeedback.blockReasonMessage);
  if (!blockReason && !blockReasonMessage) {
    return null;
  }
  return `Gemini API 安全策略拦截了本次请求${blockReasonMessage ? `: ${blockReasonMessage}` : blockReason ? `: ${blockReason}` : ''}`;
}

export function extractGeminiApiGeneratedImage(data: unknown): GeminiApiGeneratedImage | null {
  if (!isRecord(data) || !Array.isArray(data.candidates)) {
    return null;
  }
  for (const candidate of data.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }
    for (const part of candidate.content.parts) {
      if (!isRecord(part)) {
        continue;
      }
      const inlineData = isRecord(part.inlineData) ? part.inlineData : isRecord(part.inline_data) ? part.inline_data : null;
      if (!inlineData) {
        continue;
      }
      const base64 = stringValue(inlineData.data);
      if (!base64) {
        continue;
      }
      return {
        base64,
        contentType: normalizeContentType(inlineData.mimeType ?? inlineData.mime_type),
      };
    }
  }
  return null;
}

export function toGeminiApiErrorMessage(data: unknown, httpStatus: number): string {
  const promptFeedbackError = extractPromptFeedbackError(data);
  if (promptFeedbackError) {
    return promptFeedbackError;
  }

  const error = extractErrorInfo(data);
  const status = error?.status ?? '';
  const message = error?.message ?? '';
  if (status === 'UNAUTHENTICATED' || httpStatus === 401) {
    return 'Gemini API Key 无效或已失效，请检查 Nano Banana 的 API Key';
  }
  if (status === 'PERMISSION_DENIED' || httpStatus === 403) {
    return `Gemini API 无权调用 Nano Banana 模型，请确认 API Key 所属项目已开通计费并支持所选图片模型${message ? `: ${message}` : ''}`;
  }
  if (status === 'RESOURCE_EXHAUSTED' || httpStatus === 429) {
    return `Gemini API 额度不足或请求过于频繁，请检查项目额度、计费状态或稍后重试${message ? `: ${message}` : ''}`;
  }
  if (status === 'FAILED_PRECONDITION') {
    return `Gemini API 项目状态不满足调用条件，请检查计费、地区和模型访问权限${message ? `: ${message}` : ''}`;
  }
  if (status === 'INVALID_ARGUMENT' || httpStatus === 400) {
    return `Gemini API 请求参数无效${message ? `: ${message}` : ''}`;
  }
  return `Gemini API 请求失败: HTTP ${httpStatus}${message ? `: ${message}` : ''}`;
}

function buildGenerateContentUrl(settings: ExtensionSettings, model: string): string {
  const baseUrl = resolveLlmBaseUrl(settings).replace(/\/+$/u, '');
  return `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
}

function buildRequestBody(options: GeminiApiImageTranslateOptions, prompt: string): unknown {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: options.contentType || 'image/png',
              data: options.imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

export function getGeminiApiModelMetadataLabel(model: GeminiAppModel): string {
  return `Nano Banana API / ${getGeminiAppModelLabel(model)}`;
}

async function generateImage(
  options: GeminiApiImageTranslateOptions,
  stageTimings: StageTiming[],
): Promise<CloudImageTranslateSuccess> {
  const profile = options.settings.llmProfiles.gemini;
  const apiKey = profile.apiKey.trim();
  if (!apiKey) {
    throw new Error('Nano Banana API Key 不能为空');
  }
  const model = resolveGeminiApiImageModel(options.settings.geminiAppModel);

  const prompt = buildGeminiImagePrompt(options.settings);
  const url = buildGenerateContentUrl(options.settings, model);
  const start = performance.now();
  let data: unknown;
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(buildRequestBody(options, prompt)),
    });
    data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(toGeminiApiErrorMessage(data, response.status));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Gemini API 生成译图超时，请稍后重试');
    }
    throw error;
  } finally {
    stageTimings.push({
      stage: 'gemini_api_generate',
      label: 'Gemini API 生成译图',
      durationMs: performance.now() - start,
    });
  }

  const generated = extractGeminiApiGeneratedImage(data);
  if (!generated) {
    const promptFeedbackError = extractPromptFeedbackError(data);
    throw new Error(promptFeedbackError ?? 'Gemini API 未返回可用译图');
  }
  return {
    ...generated,
    metadata: {
      modelLabel: getGeminiApiModelMetadataLabel(options.settings.geminiAppModel),
      stageTimings,
    },
  };
}

async function executeGeminiApiImageTranslate(
  options: GeminiApiImageTranslateOptions,
): Promise<CloudImageTranslateSuccess> {
  const stageTimings: StageTiming[] = [];
  try {
    return await generateImage(options, stageTimings);
  } catch (error) {
    throw new Error(toErrorMessage(error));
  }
}

export function runGeminiApiImageTranslate(
  options: GeminiApiImageTranslateOptions,
): Promise<CloudImageTranslateSuccess> {
  const queued = geminiApiQueue.then(() => executeGeminiApiImageTranslate(options));
  geminiApiQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
