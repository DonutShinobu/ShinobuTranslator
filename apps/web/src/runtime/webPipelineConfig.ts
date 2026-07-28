import type { WebSettings } from '@shinobu/shared-config';
import {
  defaultExtensionSettings,
  toPipelineConfig,
} from '../../../../src/shared/config';
import type { PipelineConfig } from '../../../../src/types';

export function toWebPipelineConfig(
  settings: WebSettings,
  apiKey: string,
): PipelineConfig {
  const base = toPipelineConfig({
    ...defaultExtensionSettings,
    targetLang: settings.targetLanguage,
    processMode: settings.processMode,
    translator: 'llm',
    llmProvider: settings.translationProviderId,
  });
  const profile = settings.providerProfiles[settings.translationProviderId];
  return {
    ...base,
    llmAuthMode: 'api_key',
    llmBaseUrl: profile.baseUrl,
    llmApiKey: apiKey,
    llmModel: profile.model,
    llmUseCustomModel: settings.translationProviderId === 'custom',
    llmThinkingLevel: undefined,
  };
}
