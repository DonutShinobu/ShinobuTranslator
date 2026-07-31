import { defaultExtensionSettings } from '../shared/config';
import {
  createAuthenticationAccess,
} from '../../apps/extension/src/capabilities/authentication';
import {
  ExtensionContractError,
  ExtensionOperationError,
} from '../../apps/extension/src/capabilities/errors';
import {
  getRuntimeErrorCode,
  getRuntimeTransportMetadata,
  isRuntimeMessage,
  type RuntimeResponse,
} from '../shared/messages';
import { toErrorMessage } from '../shared/utils';
import { normalizeJsonValue } from '../shared/jsonValue';
import type {
  BackgroundExtensionCapabilities,
  JsonValue,
  PipelineHostExtensionCapabilities,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  PipelineHostConnection,
  PipelineHostDocumentLifecycle,
} from '../../apps/extension/src/pipelineHost/contracts';
import type {
  PipelineHostRuntimeComposition,
} from '../offscreen/index';
import { getGeminiAppRawResponse } from './geminiAppClient';
import { createSettingsStore } from './settings/settingsStore';
import { createDiagnosticLogStore } from './diagnostics/logStore';
import { captureVisibleTab } from './images/imageService';
import { createImageDownloader } from './images/imageDownloader';
import { registerMenusAndCommands } from './menus/registerMenus';
import {
  createOpenAiOAuthService,
} from './openai/oauthService';
import { loginGeminiApp, readGeminiAppAuthStatus } from './gemini/authService';
import { createProviderService } from './providers/providerService';
import { routeBackgroundMessage, type BackgroundServices } from './messages/router';
import { registerOffscreenPipelineBroker } from './localPipeline/offscreenBroker';

function toJsonValue(response: RuntimeResponse): JsonValue {
  return normalizeJsonValue(response);
}

export function startBackground(
  capabilities: BackgroundExtensionCapabilities,
  pipelineHostLifecycle: PipelineHostDocumentLifecycle,
): void {
  const authentication = createAuthenticationAccess({
    permissions: capabilities.permissions,
    cookies: capabilities.cookies,
  });
  const settingsStore = createSettingsStore(capabilities.persistentStorage);
  const diagnostics = createDiagnosticLogStore({
    storage: capabilities.persistentStorage,
    getSettings: settingsStore.get,
    extensionVersion: capabilities.environment.metadata.version,
  });
  const openAiOAuth = createOpenAiOAuthService({
    storage: capabilities.persistentStorage,
    authenticationTabs: capabilities.authenticationTabs,
    authentication,
  });
  const providers = createProviderService({
    getSettings: settingsStore.get,
    diagnostics,
    openAiOAuth,
    authentication,
  });
  const imageDownloader = createImageDownloader({
    permissions: capabilities.permissions,
    sessionStorage: capabilities.sessionStorage,
    referrerPolicies: capabilities.referrerPolicies,
    requestHeaderOverride: capabilities.requestHeaderOverride,
  });

  const services: BackgroundServices = {
    settings: settingsStore,
    diagnostics: {
      record: diagnostics.record,
      export: diagnostics.export,
      clear: diagnostics.clear,
    },
    images: {
      download: imageDownloader.download,
      capture: (source) => captureVisibleTab(
        capabilities.visibleTabCapture,
        {
          ...(source.windowId === undefined
            ? {}
            : { windowId: source.windowId }),
          sourceUrl: source.url ?? '',
        },
      ),
    },
    openAi: {
      status: openAiOAuth.status,
      login: openAiOAuth.login,
      logout: openAiOAuth.logout,
    },
    geminiAuth: {
      status: (settings) => readGeminiAppAuthStatus(
        settings,
        authentication,
      ),
      login: (settings) => loginGeminiApp(
        settings,
        authentication,
        capabilities.authenticationTabs,
      ),
    },
    providers,
  };

  registerOffscreenPipelineBroker(
    pipelineHostLifecycle,
    capabilities.runtimeChannels,
  );

  capabilities.runtimeRequests.onRequest(async (request, source) => {
    if (!isRuntimeMessage(request)) return undefined;
    try {
      return toJsonValue(await routeBackgroundMessage(request, source, services));
    } catch (error: unknown) {
      if (error instanceof ExtensionContractError) {
        throw error;
      }
      const geminiRawResponse = getGeminiAppRawResponse(error);
      const errorCode = getRuntimeErrorCode(error);
      const transportMetadata = getRuntimeTransportMetadata(error);
      const extensionError = error instanceof ExtensionOperationError
        ? {
            kind: 'operation' as const,
            capability: error.capability,
            operation: error.operation,
            code: error.code,
            retryable: error.retryable,
            diagnostic: error.diagnostic,
          }
        : undefined;
      return toJsonValue({
        ok: false,
        type: request.type,
        error: toErrorMessage(error),
        ...(errorCode ? { errorCode } : {}),
        ...transportMetadata,
        ...(extensionError ? { extensionError } : {}),
        ...(geminiRawResponse !== null
          ? {
              errorDetail: {
                title: 'Gemini 实际回复',
                content: geminiRawResponse,
              },
            }
          : {}),
      });
    }
  });

  capabilities.authenticationTabs.onNavigation(({ tabId, url }) => {
    void openAiOAuth.handleCallbackUrl(tabId, url);
  });
  capabilities.authenticationTabs.onClosed((tabId) => {
    void openAiOAuth.handleTabRemoved(tabId);
  });

  void settingsStore.get()
    .catch(() => defaultExtensionSettings)
    .then(settingsStore.set)
    .catch(() => undefined);

  registerMenusAndCommands(capabilities);
}

export async function startBackgroundPipelineHost(
  capabilities: PipelineHostExtensionCapabilities,
  connection: PipelineHostConnection,
  composition?: PipelineHostRuntimeComposition,
) {
  const { startOffscreenPipelineHost } = await import('../offscreen/index');
  return startOffscreenPipelineHost(capabilities, connection, composition);
}
