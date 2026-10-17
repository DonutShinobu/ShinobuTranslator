import type { PipelineConfig } from '@shinobu/image-pipeline';
import type { WebSettings } from '@shinobu/shared-config';
import { llmBuiltInProviderDefinitions } from '@shinobu/text-translation';

export function toWebPipelineConfig(
  settings: WebSettings,
): PipelineConfig {
  const profile = settings.providerProfiles[settings.translationProviderId];
  return {
    sourceLang: 'ja',
    targetLang: settings.targetLanguage,
    translator: 'llm',
    llmProvider: settings.translationProviderId,
    llmAuthMode: 'api_key',
    llmBaseUrl: settings.translationProviderId === 'alibaba'
      ? llmBuiltInProviderDefinitions.alibaba.baseUrl
      : profile.baseUrl,
    llmModel: profile.model,
    llmUseCustomModel: settings.translationProviderId === 'custom',
    llmThinkingLevel: undefined,
    typesetDebug: false,
    eraseDebug: false,
    collectDebugLog: false,
    ocrEngine: 'paddleocr_v6_medium',
    ocrPostFilter: 'balanced',
    processMode: settings.processMode,
  };
}
