import {
  buildGeminiImagePrompt,
  getGeminiAppModelLabel,
  normalizeSettings,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  toPipelineConfig,
  usesGeminiApiImagePipeline,
  usesNanoBananaImagePipeline,
  validateSettings,
} from '../../shared/config';
import { sanitizeExtensionSettings } from '../../shared/diagnosticSettings';
import {
  mergeExtensionSettingsProjection,
  toExtensionSettingsProjection,
  type ExtensionExecutionSnapshot,
  type ExtensionInterfacePreferencesPatch,
  type ExtensionSettingsProjection,
  type TranslationConfigurationProjection,
} from '../../shared/extensionControl';
import {
  ExtensionSettingsRevisionConflictError,
  type ExtensionSettingsRepository,
} from './settingsRepository';

export class TranslationConfigurationConflictError extends Error {
  readonly code = 'TRANSLATION_CONFIGURATION_CONFLICT';

  constructor(readonly actualRevision: number) {
    super('扩展翻译默认配置已更新，请重新加载后再试');
    this.name = 'TranslationConfigurationConflictError';
  }
}

export class TranslationConfigurationInvalidError extends Error {
  readonly code = 'TRANSLATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'TranslationConfigurationInvalidError';
  }
}

export type TranslationConfigurationModule = {
  read(): Promise<TranslationConfigurationProjection>;
  replace(
    settings: ExtensionSettingsProjection,
    expectedRevision: number,
  ): Promise<TranslationConfigurationProjection>;
  updateInterfacePreferences(
    preferences: ExtensionInterfacePreferencesPatch,
  ): Promise<TranslationConfigurationProjection>;
  prepareExecution(): Promise<ExtensionExecutionSnapshot>;
};

function toProjection(
  state: Awaited<ReturnType<ExtensionSettingsRepository['read']>>,
): TranslationConfigurationProjection {
  return {
    revision: state.revision,
    settings: toExtensionSettingsProjection(state.settings),
  };
}

export function createTranslationConfigurationModule(
  repository: ExtensionSettingsRepository,
): TranslationConfigurationModule {
  return {
    async read() {
      return toProjection(await repository.read());
    },
    async replace(settings, expectedRevision) {
      try {
        const state = await repository.update(
          (current) => normalizeSettings(
            mergeExtensionSettingsProjection(settings, current),
          ),
          expectedRevision,
        );
        return toProjection(state);
      } catch (error) {
        if (error instanceof ExtensionSettingsRevisionConflictError) {
          throw new TranslationConfigurationConflictError(error.actualRevision);
        }
        throw error;
      }
    },
    async updateInterfacePreferences(preferences) {
      const state = await repository.update((current) => normalizeSettings({
        ...current,
        ...preferences,
      }));
      return toProjection(state);
    },
    async prepareExecution() {
      const state = await repository.read();
      const { settings, revision } = state;
      const validationError = validateSettings(settings);
      if (validationError) {
        throw new TranslationConfigurationInvalidError(validationError);
      }
      const wholeImage = usesNanoBananaImagePipeline(settings);
      const wholeImageUsesApi = usesGeminiApiImagePipeline(settings);
      const showElapsedTime = settings.showElapsedTime === true;
      const showStageTimingDetails = showElapsedTime
        && settings.showStageTimingDetails === true;
      const snapshot: ExtensionExecutionSnapshot = {
        revision,
        kind: wholeImage ? 'whole-image' : 'local-pipeline',
        ...(wholeImage
          ? {
              wholeImage: {
                ...(wholeImageUsesApi
                  ? {
                      provider: 'gemini-api' as const,
                      model: resolveGeminiApiImageModel(settings.geminiAppModel),
                      modelLabel: `Nano Banana API / ${getGeminiAppModelLabel(settings.geminiAppModel)}`,
                      prompt: buildGeminiImagePrompt(settings),
                      baseUrl: resolveLlmBaseUrl(settings),
                    }
                  : {
                      provider: 'gemini-app' as const,
                      model: settings.geminiAppModel,
                      modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
                      prompt: buildGeminiImagePrompt(settings),
                      authMode: settings.geminiAppAuthMode,
                    }),
              },
            }
          : { pipelineConfig: toPipelineConfig(settings) }),
        display: {
          showElapsedTime,
          showStageTimingDetails,
          showRuntimeStages: showStageTimingDetails,
          stageTimingCardExpanded: settings.stageTimingCardExpanded === true,
          showTypesetDebug: settings.showTypesetDebug === true,
          showEraseDebug: settings.showEraseDebug === true,
        },
        diagnosticLogEnabled: settings.enableDebugLog === true,
        diagnosticSettings: sanitizeExtensionSettings(settings),
      };
      return snapshot;
    },
  };
}
