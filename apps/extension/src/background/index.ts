import { getExtensionApi } from '../shared/extensionRuntime';
import type { ExtensionMessageSender } from '../shared/extensionRuntime';
import {
  getRuntimeErrorCode,
  getRuntimeTransportMetadata,
  isRuntimeMessage,
  type RuntimeMessage,
  type RuntimeResponse,
} from '../shared/messages';
import { toErrorMessage } from '../shared/utils';
import { getGeminiAppRawResponse } from './geminiAppClient';
import {
  getSettings,
  getSettingsState,
  setSettingsState,
} from './settings/settingsStore';
import {
  clearDiagnosticLog,
  exportDiagnosticLog,
  recordDiagnosticLogEvent,
} from './diagnostics/logStore';
import {
  captureVisibleTab,
} from './images/imageService';
import { createImageDownloader } from './images/imageDownloader';
import { registerMenusAndCommands } from './menus/registerMenus';
import {
  getOpenAiOAuthStatus,
  handleOpenAiOAuthCallbackUrl,
  handleOpenAiOAuthTabRemoved,
  loginOpenAiOAuth,
  logoutOpenAiOAuth,
} from './openai/oauthService';
import { loginGeminiApp, readGeminiAppAuthStatus } from './gemini/authService';
import {
  handleGeminiApiImageTranslate,
  handleGeminiAppImageTranslate,
  handleLlmChatCompletions,
} from './providers/providerService';
import { routeBackgroundMessage } from './messages/router';
import type { BackgroundServices } from './messages/router';
import { registerPipelineHostBroker } from './localPipeline/offscreenBroker';
import type { PipelineHostLifecycle } from './localPipeline/pipelineHostLifecycle';
import { createExtensionSettingsRepository } from './extensionControl/settingsRepository';
import { createTranslationConfigurationModule } from './extensionControl/translationConfiguration';
import { createProviderAccessModule } from './extensionControl/providerAccess';
import { createExtensionControlModule } from './extensionControl/extensionControl';
import { registerExtensionControlPort } from './extensionControl/extensionControlPort';
import { isTrustedPopupSender } from './extensionControl/credentialDisclosurePolicy';

const imageDownloader = createImageDownloader();
const settingsRepository = createExtensionSettingsRepository({
  readState: getSettingsState,
  writeState: async (state) => {
    await setSettingsState(state);
  },
});
const translationConfiguration = createTranslationConfigurationModule(settingsRepository);
const providerAccess = createProviderAccessModule(settingsRepository, {
  openAi: {
    status: getOpenAiOAuthStatus,
    login: loginOpenAiOAuth,
    logout: logoutOpenAiOAuth,
  },
  gemini: {
    status: readGeminiAppAuthStatus,
    login: loginGeminiApp,
  },
});
const extensionControl = createExtensionControlModule(
  translationConfiguration,
  providerAccess,
);

const services: BackgroundServices = {
  settings: {
    get: getSettings,
  },
  extensionControl: {
    handle(command, sender) {
      const popupUrl = getExtensionApi()?.runtime?.getURL?.('popup.html') ?? '';
      return extensionControl.handle(command, {
        canRevealApiKeys: isTrustedPopupSender(sender, popupUrl),
      });
    },
  },
  diagnostics: {
    record: recordDiagnosticLogEvent,
    export: exportDiagnosticLog,
    clear: clearDiagnosticLog,
  },
  images: {
    download: imageDownloader.download,
    capture: captureVisibleTab,
  },
  providers: {
    llm: handleLlmChatCompletions,
    geminiAppImage: handleGeminiAppImageTranslate,
    geminiApiImage: async (message) => handleGeminiApiImageTranslate(
      message,
      await providerAccess.requireApiKey('gemini'),
    ),
  },
};


let initialized = false;

export async function dispatchBackgroundMessage(
  message: RuntimeMessage,
  sender: ExtensionMessageSender = {},
): Promise<RuntimeResponse> {
  try {
    return await routeBackgroundMessage(message, sender, services);
  } catch (error) {
    const geminiRawResponse = getGeminiAppRawResponse(error);
    const errorCode = getRuntimeErrorCode(error);
    const transportMetadata = getRuntimeTransportMetadata(error);
    return {
      ok: false,
      type: message.type,
      error: toErrorMessage(error),
      ...(errorCode ? { errorCode } : {}),
      ...transportMetadata,
      ...(geminiRawResponse !== null
        ? {
            errorDetail: {
              title: 'Gemini 实际回复',
              content: geminiRawResponse,
            },
          }
        : {}),
    } satisfies RuntimeResponse;
  }
}

export function initializeBackground(lifecycle: PipelineHostLifecycle): void {
  if (initialized) return;
  const chromeApi = getExtensionApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }
  initialized = true;

  registerPipelineHostBroker(chromeApi, lifecycle);
  registerExtensionControlPort(chromeApi, extensionControl);

  chromeApi.runtime.onMessage.addListener((message: unknown, sender: ExtensionMessageSender, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void dispatchBackgroundMessage(message, sender)
      .then((response) => {
        sendResponse(response);
      });
    return true;
  });

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.url === 'string') {
      void handleOpenAiOAuthCallbackUrl(tabId, changeInfo.url)
        .then((changed) => changed ? extensionControl.refreshProviderAccess() : undefined);
    }
    const tabUrl = changeInfo.url ?? tab.url ?? '';
    if (changeInfo.status === 'complete' && tabUrl.startsWith('https://gemini.google.com/')) {
      void extensionControl.refreshProviderAccess();
    }
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    void handleOpenAiOAuthTabRemoved(tabId)
      .then((changed) => changed ? extensionControl.refreshProviderAccess() : undefined);
  });

  chromeApi.cookies?.onChanged?.addListener(({ cookie }) => {
    if (cookie.domain.includes('google.com')) {
      void extensionControl.refreshProviderAccess();
    }
  });

  chromeApi.permissions?.onAdded?.addListener(() => {
    void extensionControl.refreshProviderAccess();
  });

  chromeApi.permissions?.onRemoved?.addListener(() => {
    void extensionControl.refreshProviderAccess();
  });

  void getSettings()
    .catch(() => undefined);

  registerMenusAndCommands();
}
