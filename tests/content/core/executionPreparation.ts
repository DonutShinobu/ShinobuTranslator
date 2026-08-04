import {
  buildGeminiImagePrompt,
  defaultExtensionSettings,
  getGeminiAppModelLabel,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  toPipelineConfig,
  usesGeminiApiImagePipeline,
  usesNanoBananaImagePipeline,
  type ExtensionSettings,
} from '../../../apps/extension/src/shared/config';
import { sanitizeExtensionSettings } from '../../../apps/extension/src/shared/diagnosticSettings';
import type { ExtensionExecutionSnapshot } from '../../../apps/extension/src/shared/extensionControl';
import type { WholeImageExecutionPreparation } from '../../../apps/extension/src/shared/extensionControl';

export function executionSnapshotFromSettings(
  settings: ExtensionSettings = defaultExtensionSettings,
): ExtensionExecutionSnapshot {
  const wholeImage = usesNanoBananaImagePipeline(settings);
  const wholeImagePreparation: WholeImageExecutionPreparation | undefined = wholeImage
    ? usesGeminiApiImagePipeline(settings)
      ? {
          provider: 'gemini-api',
          model: resolveGeminiApiImageModel(settings.geminiAppModel),
          modelLabel: `Nano Banana API / ${getGeminiAppModelLabel(settings.geminiAppModel)}`,
          prompt: buildGeminiImagePrompt(settings),
          baseUrl: resolveLlmBaseUrl(settings),
        }
      : {
          provider: 'gemini-app',
          model: settings.geminiAppModel,
          modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
          prompt: buildGeminiImagePrompt(settings),
          authMode: settings.geminiAppAuthMode,
        }
    : undefined;
  const showStageTimingDetails = settings.showElapsedTime && settings.showStageTimingDetails;
  return {
    revision: 1,
    kind: wholeImage ? 'whole-image' : 'local-pipeline',
    ...(wholeImage
      ? {
          wholeImage: wholeImagePreparation!,
        }
      : { pipelineConfig: toPipelineConfig(settings) }),
    display: {
      showElapsedTime: settings.showElapsedTime,
      showStageTimingDetails,
      showRuntimeStages: showStageTimingDetails,
      stageTimingCardExpanded: settings.stageTimingCardExpanded,
      showTypesetDebug: settings.showTypesetDebug,
      showEraseDebug: settings.showEraseDebug,
    },
    diagnosticLogEnabled: settings.enableDebugLog,
    diagnosticSettings: sanitizeExtensionSettings(settings),
  };
}

export function prepareExecutionFromSettings(
  settings: ExtensionSettings = defaultExtensionSettings,
): () => Promise<ExtensionExecutionSnapshot> {
  return async () => executionSnapshotFromSettings(settings);
}
