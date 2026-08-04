import type { OpenAiOAuthStatusInfo } from '@shinobu/text-translation/openai';
import { normalizeSettings, type ExtensionSettings, type LlmProvider } from '../../shared/config';
import type {
  ProviderAccessProjection,
  ProviderAuthorizationAction,
  ProviderAuthorizationProjection,
  ProviderAuthorizationTarget,
} from '../../shared/extensionControl';
import type { ExtensionSettingsRepository } from './settingsRepository';

type GeminiAppAuthStatus = {
  authenticated: boolean;
  pending?: boolean;
  error?: string;
};

export type ProviderAccessDependencies = {
  openAi: {
    status(): Promise<OpenAiOAuthStatusInfo>;
    login(): Promise<OpenAiOAuthStatusInfo>;
    logout(): Promise<OpenAiOAuthStatusInfo>;
  };
  gemini: {
    status(settings: ExtensionSettings): Promise<GeminiAppAuthStatus>;
    login(settings: ExtensionSettings): Promise<GeminiAppAuthStatus>;
  };
};

export type ProviderAccessModule = {
  read(): Promise<ProviderAccessProjection>;
  refresh(target?: ProviderAuthorizationTarget): Promise<ProviderAccessProjection>;
  replaceApiKey(
    provider: LlmProvider,
    apiKey: string,
  ): Promise<ProviderAccessProjection>;
  clearApiKey(provider: LlmProvider): Promise<ProviderAccessProjection>;
  revealApiKey(provider: LlmProvider): Promise<string>;
  requireApiKey(provider: LlmProvider): Promise<string>;
  perform(
    target: ProviderAuthorizationTarget,
    action: ProviderAuthorizationAction,
  ): Promise<ProviderAccessProjection>;
};

export class ProviderAccessActionNotSupportedError extends Error {
  readonly code = 'PROVIDER_ACCESS_ACTION_NOT_SUPPORTED';

  constructor(
    readonly target: ProviderAuthorizationTarget,
    readonly action: ProviderAuthorizationAction,
  ) {
    super(`当前供应商访问方式不支持 ${action} 操作`);
    this.name = 'ProviderAccessActionNotSupportedError';
  }
}

function toAuthorizationProjection(
  status: GeminiAppAuthStatus & Pick<OpenAiOAuthStatusInfo, 'email' | 'planType'>,
  supportsLogout: boolean,
): ProviderAuthorizationProjection {
  if (status.authenticated) {
    return {
      state: 'ready',
      availableActions: supportsLogout ? ['refresh', 'logout'] : ['refresh'],
      ...((status.email || status.planType)
        ? {
            identity: {
              ...(status.email ? { email: status.email } : {}),
              ...(status.planType ? { planType: status.planType } : {}),
            },
          }
        : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  }
  if (status.pending) {
    return {
      state: 'authorizing',
      availableActions: ['refresh'],
      ...(status.error ? { error: status.error } : {}),
    };
  }
  return {
    state: 'action-required',
    availableActions: ['refresh', 'login'],
    ...(status.error ? { error: status.error } : {}),
  };
}

export function createProviderAccessModule(
  repository: ExtensionSettingsRepository,
  dependencies: ProviderAccessDependencies,
): ProviderAccessModule {
  let cachedOpenAi: ProviderAuthorizationProjection | null = null;
  let cachedGemini: ProviderAuthorizationProjection | null = null;
  let openAiOperation = 0;
  let geminiOperation = 0;
  let openAiRefreshInFlight: {
    operation: number;
    promise: Promise<void>;
  } | null = null;
  let geminiRefreshInFlight: {
    operation: number;
    authMode: ExtensionSettings['geminiAppAuthMode'];
    promise: Promise<void>;
  } | null = null;

  const defaultAuthorization = (): ProviderAuthorizationProjection => ({
    state: 'action-required',
    availableActions: ['refresh', 'login'],
  });

  async function project(): Promise<ProviderAccessProjection> {
    const state = await repository.read();
    const apiKeys = Object.fromEntries(
      Object.entries(state.settings.llmProfiles).map(([provider, profile]) => [
        provider,
        { configured: profile.apiKey.trim().length > 0 },
      ]),
    ) as ProviderAccessProjection['apiKeys'];
    return {
      revision: state.revision,
      apiKeys,
      openAiOAuth: cachedOpenAi ?? defaultAuthorization(),
      geminiApp: cachedGemini ?? defaultAuthorization(),
    };
  }

  function refreshOpenAi(): Promise<void> {
    if (
      openAiRefreshInFlight
      && openAiRefreshInFlight.operation === openAiOperation
    ) {
      return openAiRefreshInFlight.promise;
    }
    const operation = ++openAiOperation;
    const inFlight = {
      operation,
      promise: Promise.resolve(),
    };
    inFlight.promise = Promise.resolve()
      .then(() => dependencies.openAi.status())
      .then((status) => {
        if (operation === openAiOperation) {
          cachedOpenAi = toAuthorizationProjection(status, true);
        }
      })
      .finally(() => {
        if (openAiRefreshInFlight === inFlight) {
          openAiRefreshInFlight = null;
        }
      });
    openAiRefreshInFlight = inFlight;
    return inFlight.promise;
  }

  function refreshGemini(settings: ExtensionSettings): Promise<void> {
    const authMode = settings.geminiAppAuthMode;
    if (
      geminiRefreshInFlight
      && geminiRefreshInFlight.operation === geminiOperation
      && geminiRefreshInFlight.authMode === authMode
    ) {
      return geminiRefreshInFlight.promise;
    }
    const operation = ++geminiOperation;
    const inFlight = {
      operation,
      authMode,
      promise: Promise.resolve(),
    };
    inFlight.promise = Promise.resolve()
      .then(() => dependencies.gemini.status(settings))
      .then((status) => {
        if (operation === geminiOperation) {
          cachedGemini = toAuthorizationProjection(status, false);
        }
      })
      .finally(() => {
        if (geminiRefreshInFlight === inFlight) {
          geminiRefreshInFlight = null;
        }
      });
    geminiRefreshInFlight = inFlight;
    return inFlight.promise;
  }

  async function refresh(
    target?: ProviderAuthorizationTarget,
  ): Promise<ProviderAccessProjection> {
    if (target === 'openai-oauth') {
      await refreshOpenAi();
      return project();
    }
    const state = await repository.read();
    if (target === 'gemini-app') {
      await refreshGemini(state.settings);
      return project();
    }
    await Promise.all([refreshOpenAi(), refreshGemini(state.settings)]);
    return project();
  }

  const read = project;

  async function writeApiKey(
    provider: LlmProvider,
    apiKey: string,
  ): Promise<ProviderAccessProjection> {
    await repository.update((current) => normalizeSettings({
      ...current,
      llmProfiles: {
        ...current.llmProfiles,
        [provider]: {
          ...current.llmProfiles[provider],
          apiKey: apiKey.trim(),
        },
      },
    }));
    return read();
  }

  return {
    read,
    refresh,
    replaceApiKey(provider, apiKey) {
      return writeApiKey(provider, apiKey);
    },
    clearApiKey(provider) {
      return writeApiKey(provider, '');
    },
    async revealApiKey(provider) {
      return (await repository.read()).settings.llmProfiles[provider].apiKey.trim();
    },
    async requireApiKey(provider) {
      const apiKey = (await repository.read()).settings.llmProfiles[provider].apiKey.trim();
      if (!apiKey) throw new Error('当前供应商尚未配置 API Key');
      return apiKey;
    },
    async perform(target, action) {
      if (target === 'openai-oauth') {
        if (action === 'refresh') {
          await refreshOpenAi();
          return project();
        }
        const operation = ++openAiOperation;
        const status = action === 'login'
          ? await dependencies.openAi.login()
          : await dependencies.openAi.logout();
        if (operation === openAiOperation) {
          cachedOpenAi = toAuthorizationProjection(status, true);
        }
        return project();
      }
      if (action === 'logout') {
        throw new ProviderAccessActionNotSupportedError(target, action);
      }
      const state = await repository.read();
      if (action === 'refresh') {
        await refreshGemini(state.settings);
        return project();
      }
      const operation = ++geminiOperation;
      const status = await dependencies.gemini.login(state.settings);
      if (operation === geminiOperation) {
        cachedGemini = toAuthorizationProjection(status, false);
      }
      return project();
    },
  };
}
