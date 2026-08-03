import type { PipelineConfig } from '@shinobu/image-pipeline';
import {
  sanitizeDiagnosticUrl,
  type SanitizedSettingsSnapshot,
} from '@shinobu/diagnostics';
import {
  resolveLlmBaseUrl,
  resolveLlmModel,
  type ExtensionSettings,
} from './config';

export function sanitizeExtensionSettings(
  settings: ExtensionSettings,
): SanitizedSettingsSnapshot {
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmAuthMode: profile.authMode,
    llmBaseUrl: sanitizeDiagnosticUrl(resolveLlmBaseUrl(settings)),
    llmModel: resolveLlmModel(settings),
    targetLang: settings.targetLang,
    processMode: settings.processMode,
    ocrEngine: settings.ocrEngine,
    showElapsedTime: settings.showElapsedTime,
    showStageTimingDetails: settings.showStageTimingDetails,
    showTypesetDebug: settings.showTypesetDebug,
    showEraseDebug: settings.showEraseDebug,
    ocrPostFilter: settings.disableOcrPostFilter ? 'off' : 'balanced',
    enableDebugLog: settings.enableDebugLog,
  };
}

export function sanitizePipelineConfig(
  config: PipelineConfig,
): SanitizedSettingsSnapshot {
  return {
    translator: config.translator,
    llmProvider: config.llmProvider,
    llmAuthMode: config.llmAuthMode,
    llmBaseUrl: sanitizeDiagnosticUrl(config.llmBaseUrl),
    llmModel: config.llmModel,
    targetLang: config.targetLang,
    processMode: config.processMode,
    ocrEngine: config.ocrEngine,
    showTypesetDebug: config.typesetDebug,
    showEraseDebug: config.eraseDebug,
    ocrPostFilter: config.ocrPostFilter ?? 'balanced',
    collectDebugLog: config.collectDebugLog,
  };
}
