import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
} from '../shared/config';
import { getChromeApi } from '../shared/chrome';
import type { ChromeMessageSender } from '../shared/chrome';
import {
  getRuntimeErrorCode,
  isRuntimeMessage,
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
import { registerOffscreenPipelineBroker } from './localPipeline/offscreenBroker';

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


function initializeBackground(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }

  registerOffscreenPipelineBroker(chromeApi);

  chromeApi.runtime.onMessage.addListener((message: unknown, sender: ChromeMessageSender, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void routeBackgroundMessage(message, sender, services)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        const geminiRawResponse = getGeminiAppRawResponse(error);
        const errorCode = getRuntimeErrorCode(error);
        sendResponse({
          ok: false,
          type: message.type,
          error: toErrorMessage(error),
          ...(errorCode ? { errorCode } : {}),
          ...(geminiRawResponse !== null
            ? {
                errorDetail: {
                  title: 'Gemini 实际回复',
                  content: geminiRawResponse,
                },
              }
            : {}),
        } satisfies RuntimeResponse);
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

void initializeBackground();
