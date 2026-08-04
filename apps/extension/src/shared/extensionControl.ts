import type { PipelineConfig } from '@shinobu/image-pipeline';
import type { SanitizedSettingsSnapshot } from '@shinobu/diagnostics';
import type {
  ExtensionSettings,
  GeminiAppAuthMode,
  GeminiAppModel,
  LlmProvider,
  LlmProviderProfile,
} from './config';

export type PublicLlmProviderProfile = Omit<LlmProviderProfile, 'apiKey'>;

export type ExtensionSettingsProjection = Omit<ExtensionSettings, 'llmProfiles'> & {
  llmProfiles: Record<LlmProvider, PublicLlmProviderProfile>;
};

export type TranslationConfigurationProjection = {
  revision: number;
  settings: ExtensionSettingsProjection;
};

export type ExecutionDisplayPreferences = {
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  showRuntimeStages: boolean;
  stageTimingCardExpanded: boolean;
  showTypesetDebug: boolean;
  showEraseDebug: boolean;
};

type WholeImageExecutionPreparationBase = {
  modelLabel: string;
  prompt: string;
};

export type WholeImageExecutionPreparation =
  | WholeImageExecutionPreparationBase & {
      provider: 'gemini-app';
      model: GeminiAppModel;
      authMode: GeminiAppAuthMode;
    }
  | WholeImageExecutionPreparationBase & {
      provider: 'gemini-api';
      model: string;
      baseUrl: string;
    };

export type ExtensionExecutionSnapshot = {
  revision: number;
  kind: 'local-pipeline' | 'whole-image';
  pipelineConfig?: PipelineConfig;
  wholeImage?: WholeImageExecutionPreparation;
  display: ExecutionDisplayPreferences;
  diagnosticLogEnabled: boolean;
  diagnosticSettings: SanitizedSettingsSnapshot;
};

export type ProviderAuthorizationTarget = 'openai-oauth' | 'gemini-app';
export type ProviderAuthorizationAction = 'refresh' | 'login' | 'logout';

export function resolveProviderAuthorizationTarget(
  settings: ExtensionSettingsProjection,
): ProviderAuthorizationTarget | null {
  if (settings.translator !== 'llm') return null;
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'openai' && profile.authMode === 'openai_oauth') {
    return 'openai-oauth';
  }
  if (settings.llmProvider === 'gemini' && profile.authMode === 'gemini_app') {
    return 'gemini-app';
  }
  return null;
}

export type ProviderAuthorizationProjection = {
  state: 'ready' | 'authorizing' | 'action-required';
  availableActions: ProviderAuthorizationAction[];
  identity?: {
    email?: string;
    planType?: string;
  };
  error?: string;
};

export type ProviderAccessProjection = {
  revision: number;
  apiKeys: Record<LlmProvider, { configured: boolean }>;
  openAiOAuth: ProviderAuthorizationProjection;
  geminiApp: ProviderAuthorizationProjection;
};

export type ExtensionControlProjection = {
  revision: number;
  settings: ExtensionSettingsProjection;
  access: Omit<ProviderAccessProjection, 'revision'>;
};

export type ExtensionInterfacePreferencesPatch = Partial<Pick<
  ExtensionSettingsProjection,
  | 'showElapsedTime'
  | 'showStageTimingDetails'
  | 'stageTimingCardExpanded'
  | 'debugOptionsExpanded'
>>;

export type ExtensionControlCommand =
  | { kind: 'read' }
  | {
      kind: 'replace-settings';
      settings: ExtensionSettingsProjection;
      expectedRevision: number;
    }
  | {
      kind: 'update-interface-preferences';
      preferences: ExtensionInterfacePreferencesPatch;
    }
  | { kind: 'replace-api-key'; provider: LlmProvider; apiKey: string }
  | { kind: 'clear-api-key'; provider: LlmProvider }
  | { kind: 'reveal-api-key'; provider: LlmProvider }
  | {
      kind: 'perform-access';
      target: ProviderAuthorizationTarget;
      action: ProviderAuthorizationAction;
    }
  | { kind: 'prepare-execution' };

export type ExtensionControlResult =
  | { kind: 'control-projection'; projection: ExtensionControlProjection }
  | { kind: 'api-key-disclosure'; provider: LlmProvider; apiKey: string }
  | { kind: 'execution-snapshot'; snapshot: ExtensionExecutionSnapshot };

export function toExtensionSettingsProjection(
  settings: ExtensionSettings,
): ExtensionSettingsProjection {
  const llmProfiles = Object.fromEntries(
    Object.entries(settings.llmProfiles).map(([provider, profile]) => {
      const { apiKey: _credential, ...projection } = profile;
      return [provider, projection];
    }),
  ) as Record<LlmProvider, PublicLlmProviderProfile>;
  return {
    ...settings,
    llmProfiles,
  };
}

export function mergeExtensionSettingsProjection(
  projection: ExtensionSettingsProjection,
  current: ExtensionSettings,
): ExtensionSettings {
  const llmProfiles = Object.fromEntries(
    Object.entries(projection.llmProfiles).map(([provider, profile]) => [
      provider,
      {
        ...profile,
        apiKey: current.llmProfiles[provider as LlmProvider].apiKey,
      },
    ]),
  ) as Record<LlmProvider, LlmProviderProfile>;
  return {
    ...projection,
    llmProfiles,
  };
}
