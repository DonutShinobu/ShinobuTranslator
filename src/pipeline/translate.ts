import type { PipelineConfig, TextRegion, TranslationDebugInfo } from '../types';
import { LlmColumnsParseError, llmTranslate, llmTranslateRegions } from '../translators/llm';
import { googleWebTranslate } from '../translators/googleWeb';

async function translateOne(text: string, config: PipelineConfig): Promise<string> {
  if (!text.trim()) {
    return '';
  }

  if (config.translator === 'google_web') {
    return googleWebTranslate(text, config.sourceLang, config.targetLang);
  }

  if (!config.llmApiKey.trim()) {
    throw new Error('LLM 模式需要填写 API Key');
  }

  return llmTranslate({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
    temperature: config.llmTemperature,
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
    if (!config.llmApiKey.trim()) {
      throw new Error('LLM 模式需要填写 API Key');
    }

    let batched = new Map<string, { translatedText: string; translatedColumns?: string[] }>();
    let translationDebug: TranslationDebugInfo | null = null;
    try {
      const batchedResult = await llmTranslateRegions({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        temperature: config.llmTemperature,
        from: config.sourceLang,
        to: config.targetLang,
        regions: regions.map((region) => ({
          id: region.id,
          text: region.sourceText,
          direction: region.direction ?? 'h',
          targetColumns: region.direction === 'v' ? Math.max(1, region.originalLineCount ?? 1) : undefined,
        })),
      });
      batched = batchedResult.byId;
      translationDebug = {
        llmBatchRawResponse: batchedResult.rawContent,
      };
    } catch (error) {
      batched = new Map();
      if (error instanceof LlmColumnsParseError) {
        translationDebug = {
          llmBatchRawResponse: error.rawContent,
          llmBatchParseError: error.message,
        };
      }
    }

    const next: TextRegion[] = [];
    for (const region of regions) {
      const result = batched.get(region.id);
      if (result?.translatedText) {
        next.push({
          ...region,
          translatedText: result.translatedText,
          translatedColumns: region.direction === 'v' ? result.translatedColumns : undefined,
        });
        continue;
      }

      const translatedText = await translateOne(region.sourceText, config);
      next.push({ ...region, translatedText, translatedColumns: undefined });
    }
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
