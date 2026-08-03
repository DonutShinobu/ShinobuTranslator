import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
} from '../shared/config';
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
import { storageSet } from './storage/chromeStorage';
import { getSettings, setSettings } from './settings/settingsStore';
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

const imageDownloader = createImageDownloader();

const services: BackgroundServices = {
  settings: {
    get: getSettings,
    set: setSettings,
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
  openAi: {
    status: getOpenAiOAuthStatus,
    login: loginOpenAiOAuth,
    logout: logoutOpenAiOAuth,
  },
  geminiAuth: {
    status: readGeminiAppAuthStatus,
    login: loginGeminiApp,
  },
  providers: {
    llm: handleLlmChatCompletions,
    geminiAppImage: handleGeminiAppImageTranslate,
    geminiApiImage: handleGeminiApiImageTranslate,
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

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (typeof changeInfo.url === 'string') {
      void handleOpenAiOAuthCallbackUrl(tabId, changeInfo.url);
    }
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    void handleOpenAiOAuthTabRemoved(tabId);
  });

  void getSettings()
    .catch(() => defaultExtensionSettings)
    .then((settings) => storageSet(extensionSettingsStorageKey, settings))
    .catch(() => undefined);

  registerMenusAndCommands();
}
