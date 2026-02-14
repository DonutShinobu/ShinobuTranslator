import type { PipelineConfig, TextRegion } from '../types';
import { llmTranslate } from '../translators/llm';
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
    from: config.sourceLang,
    to: config.targetLang,
    text,
  });
}

export async function runTranslate(regions: TextRegion[], config: PipelineConfig): Promise<TextRegion[]> {
  const next: TextRegion[] = [];
  for (const region of regions) {
    const translatedText = await translateOne(region.sourceText, config);
    next.push({ ...region, translatedText });
  }
  return next;
}
