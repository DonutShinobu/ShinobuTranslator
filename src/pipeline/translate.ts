import type { PipelineConfig, TextRegion, TranslationDebugInfo } from '../types';
import {
  LlmColumnsParseError,
  LlmThinkingConfigError,
  llmTranslate,
  llmTranslateRegions,
} from '../translators/llm';
import {
  extensionTextTranslationTransport,
  type TextTranslationTransport,
} from '../translators/transport';
import { isPipelineFailureEnvelope } from '@shinobu/image-pipeline';

type LlmRegionRequest = {
  id: string;
  text: string;
  direction: 'h' | 'v';
  targetColumns?: number;
  targetLines?: number;
};

type StructuredTranslationResult = {
  translatedText: string;
  translatedColumns?: string[];
};

function requiresPipelineLlmApiKey(config: PipelineConfig): boolean {
  return config.llmProvider !== 'gemini' && !(config.llmProvider === 'openai' && config.llmAuthMode === 'openai_oauth');
}

function assertTextTranslationProvider(config: PipelineConfig): void {
  if (config.llmProvider === 'gemini') {
    throw new Error('Nano Banana 使用端到端译图流程，不支持 OCR 文本翻译流程');
  }
}

function isTweetContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\bHTTP\s*413\b/iu.test(message)
    || /context[_\s-]*(?:length|window)/iu.test(message)
    || /(?:prompt|request|payload)(?:\s+entity)?\s+(?:is\s+)?too\s+large/iu.test(message)
    || /prompt\s+(?:is\s+)?too\s+long/iu.test(message)
    || /too\s+many\s+(?:input\s+)?tokens?/iu.test(message)
    || /(?:input|prompt).{0,40}tokens?.{0,40}(?:exceed|limit|maximum)/iu.test(message)
    || /上下文(?:长度|窗口).*(?:超|限制|过长|最大)/u.test(message)
    || /(?:输入|提示词|请求).*(?:token|令牌).*(?:超|过多|限制)/iu.test(message)
  );
}

function buildLlmRegionRequest(region: TextRegion): LlmRegionRequest {
  const direction = region.direction ?? 'h';
  return {
    id: region.id,
    text: region.sourceText,
    direction,
    targetColumns: direction === 'v' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
    targetLines: direction === 'h' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
  };
}

export type RunTranslateOptions = {
  signal?: AbortSignal;
  transport?: TextTranslationTransport;
};

function hasPipelineFailure(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'failure' in error
    && isPipelineFailureEnvelope(error.failure);
}

async function translateOne(
  text: string,
  config: PipelineConfig,
  options: RunTranslateOptions,
): Promise<string> {
  if (!text.trim()) {
    return '';
  }

  if (config.translator === 'google_web') {
    return (options.transport ?? extensionTextTranslationTransport).translatePlain({
      text,
      from: config.sourceLang,
      to: config.targetLang,
      signal: options.signal,
    });
  }

  assertTextTranslationProvider(config);

  if (requiresPipelineLlmApiKey(config) && !config.llmApiKey.trim()) {
    throw new Error('LLM 模式需要填写 API Key');
  }

  return llmTranslate({
    provider: config.llmProvider,
    authMode: config.llmAuthMode,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    useCustomModel: config.llmUseCustomModel === true,
    thinkingLevel: config.llmUseCustomModel ? undefined : config.llmThinkingLevel,
    from: config.sourceLang,
    to: config.targetLang,
    text,
    translationContext: config.translationContext,
    diagnosticRunId: config.diagnosticRunId,
    apiKey: config.llmApiKey,
    signal: options.signal,
    transport: options.transport,
  });
}

async function translateOneStructured(
  region: TextRegion,
  config: PipelineConfig,
  options: RunTranslateOptions,
): Promise<StructuredTranslationResult> {
  const result = await llmTranslateRegions({
    provider: config.llmProvider,
    authMode: config.llmAuthMode,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    useCustomModel: config.llmUseCustomModel === true,
    thinkingLevel: config.llmUseCustomModel ? undefined : config.llmThinkingLevel,
    from: config.sourceLang,
    to: config.targetLang,
    regions: [buildLlmRegionRequest(region)],
    translationContext: config.translationContext,
    diagnosticRunId: config.diagnosticRunId,
    apiKey: config.llmApiKey,
    signal: options.signal,
    transport: options.transport,
  });
  const translated = result.byId.get(region.id);
  if (!translated?.translatedText) {
    throw new Error('LLM 单框结构化翻译未返回译文');
  }
  return translated;
}

export type RunTranslateResult = {
  regions: TextRegion[];
  translationDebug: TranslationDebugInfo | null;
};

export async function runTranslate(
  regions: TextRegion[],
  config: PipelineConfig,
  options: RunTranslateOptions = {},
): Promise<RunTranslateResult> {
  if (regions.length === 0) {
    return {
      regions: [],
      translationDebug: null,
    };
  }

  if (config.translator === 'llm') {
    assertTextTranslationProvider(config);

    if (requiresPipelineLlmApiKey(config) && !config.llmApiKey.trim()) {
      throw new Error('LLM 模式需要填写 API Key');
    }

    let activeConfig = config;
    let tweetContextLengthFallback = false;
    const runLlmRequest = async <T>(
      request: (requestConfig: PipelineConfig) => Promise<T>,
    ): Promise<T> => {
      try {
        return await request(activeConfig);
      } catch (error) {
        if (
          !tweetContextLengthFallback
          && activeConfig.translationContext
          && isTweetContextLengthError(error)
        ) {
          activeConfig = {
            ...activeConfig,
            translationContext: undefined,
          };
          tweetContextLengthFallback = true;
          return request(activeConfig);
        }
        throw error;
      }
    };

    let batched = new Map<string, { translatedText: string; translatedColumns?: string[] }>();
    const translationDebug: TranslationDebugInfo = {
      llmBatchRequestedRegionCount: regions.length,
      llmBatchFailed: false,
    };
    try {
      const batchedResult = await runLlmRequest((requestConfig) => llmTranslateRegions({
        provider: requestConfig.llmProvider,
        authMode: requestConfig.llmAuthMode,
        baseUrl: requestConfig.llmBaseUrl,
        model: requestConfig.llmModel,
        useCustomModel: requestConfig.llmUseCustomModel === true,
        thinkingLevel: requestConfig.llmUseCustomModel ? undefined : requestConfig.llmThinkingLevel,
        from: requestConfig.sourceLang,
        to: requestConfig.targetLang,
        regions: regions.map(buildLlmRegionRequest),
        translationContext: requestConfig.translationContext,
        diagnosticRunId: requestConfig.diagnosticRunId,
        apiKey: requestConfig.llmApiKey,
        signal: options.signal,
        transport: options.transport,
      }));
      batched = batchedResult.byId;
      translationDebug.llmBatchRawResponse = batchedResult.rawContent;
    } catch (error) {
      if (error instanceof LlmThinkingConfigError || hasPipelineFailure(error)) {
        throw error;
      }
      batched = new Map();
      translationDebug.llmBatchFailed = true;
      translationDebug.llmBatchError = error instanceof Error ? error.message : String(error);
      if (error instanceof LlmColumnsParseError) {
        translationDebug.llmBatchRawResponse = error.rawContent;
        translationDebug.llmBatchParseError = error.message;
      }
    }

    const next: TextRegion[] = [];
    let llmBatchHitRegionCount = 0;
    let llmFallbackRegionCount = 0;
    let llmFallbackRequestCount = 0;
    for (const region of regions) {
      const result = batched.get(region.id);
      if (result?.translatedText) {
        llmBatchHitRegionCount += 1;
        next.push({
          ...region,
          translatedText: result.translatedText,
          translatedColumns: result.translatedColumns,
        });
        continue;
      }

      llmFallbackRegionCount += 1;
      if (region.sourceText.trim()) {
        llmFallbackRequestCount += 1;
        try {
          const translated = await runLlmRequest(
            (requestConfig) => translateOneStructured(region, requestConfig, options),
          );
          next.push({
            ...region,
            translatedText: translated.translatedText,
            translatedColumns: translated.translatedColumns,
          });
          continue;
        } catch (error) {
          if (error instanceof LlmThinkingConfigError || hasPipelineFailure(error)) {
            throw error;
          }
          llmFallbackRequestCount += 1;
        }
      }
      const translatedText = await runLlmRequest(
        (requestConfig) => translateOne(region.sourceText, requestConfig, options),
      );
      next.push({ ...region, translatedText, translatedColumns: undefined });
    }
    translationDebug.llmBatchHitRegionCount = llmBatchHitRegionCount;
    translationDebug.llmFallbackRegionCount = llmFallbackRegionCount;
    translationDebug.llmFallbackRequestCount = llmFallbackRequestCount;
    translationDebug.llmFallbackUsed = llmFallbackRegionCount > 0;
    if (tweetContextLengthFallback) {
      translationDebug.tweetContextLengthFallback = true;
    }
    return {
      regions: next,
      translationDebug,
    };
  }

  const next: TextRegion[] = [];
  for (const region of regions) {
    const translatedText = await translateOne(region.sourceText, config, options);
    next.push({ ...region, translatedText });
  }
  return {
    regions: next,
    translationDebug: null,
  };
}
