import type { PipelineConfig, TextRegion, TranslationDebugInfo } from '../types';
import { LlmColumnsParseError, llmTranslate, llmTranslateRegions } from '../translators/llm';
import { googleWebTranslate } from '../translators/googleWeb';

function requiresPipelineLlmApiKey(config: PipelineConfig): boolean {
  return config.llmProvider !== 'gemini' && !(config.llmProvider === 'openai' && config.llmAuthMode === 'openai_oauth');
}

function assertTextTranslationProvider(config: PipelineConfig): void {
  if (config.llmProvider === 'gemini') {
    throw new Error('Nano Banana 使用端到端译图流程，不支持 OCR 文本翻译流程');
  }
}

async function translateOne(text: string, config: PipelineConfig): Promise<string> {
  if (!text.trim()) {
    return '';
  }

  if (config.translator === 'google_web') {
    return googleWebTranslate(text, config.sourceLang, config.targetLang);
  }

  assertTextTranslationProvider(config);

  if (requiresPipelineLlmApiKey(config) && !config.llmApiKey.trim()) {
    throw new Error('LLM 模式需要填写 API Key');
  }

  return llmTranslate({
    provider: config.llmProvider,
    authMode: config.llmAuthMode,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    from: config.sourceLang,
    to: config.targetLang,
    text,
  });
}

export type RunTranslateResult = {
  regions: TextRegion[];
  translationDebug: TranslationDebugInfo | null;
};

export async function runTranslate(regions: TextRegion[], config: PipelineConfig): Promise<RunTranslateResult> {
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

    let batched = new Map<string, { translatedText: string; translatedColumns?: string[] }>();
    const translationDebug: TranslationDebugInfo = {
      llmBatchRequestedRegionCount: regions.length,
      llmBatchFailed: false,
    };
    try {
      const batchedResult = await llmTranslateRegions({
        provider: config.llmProvider,
        authMode: config.llmAuthMode,
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        from: config.sourceLang,
        to: config.targetLang,
        regions: regions.map((region) => ({
          id: region.id,
          text: region.sourceText,
          direction: region.direction ?? 'h',
          targetColumns: region.direction === 'v' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
          targetLines: region.direction === 'h' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
        })),
      });
      batched = batchedResult.byId;
      translationDebug.llmBatchRawResponse = batchedResult.rawContent;
    } catch (error) {
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
      }
      const translatedText = await translateOne(region.sourceText, config);
      next.push({ ...region, translatedText, translatedColumns: undefined });
    }
    translationDebug.llmBatchHitRegionCount = llmBatchHitRegionCount;
    translationDebug.llmFallbackRegionCount = llmFallbackRegionCount;
    translationDebug.llmFallbackRequestCount = llmFallbackRequestCount;
    translationDebug.llmFallbackUsed = llmFallbackRegionCount > 0;
    return {
      regions: next,
      translationDebug,
    };
  }

  const next: TextRegion[] = [];
  for (const region of regions) {
    const translatedText = await translateOne(region.sourceText, config);
    next.push({ ...region, translatedText });
  }
  return {
    regions: next,
    translationDebug: null,
  };
}
