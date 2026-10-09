import { createRoot } from 'react-dom/client';
import { App } from '../../../apps/extension/src/popup/App';
import '../../../apps/extension/src/popup/styles.css';
import {
  defaultExtensionSettings,
  normalizeSettings,
  type LlmProvider,
} from '../../../apps/extension/src/shared/config';
import {
  toExtensionSettingsProjection,
  type ExtensionControlCommand,
  type ExtensionControlProjection,
} from '../../../apps/extension/src/shared/extensionControl';
import type { ExtensionBrowserApi } from '../../../apps/extension/src/shared/extensionRuntime';

export type PopupPreview = {
  getProjection: () => ExtensionControlProjection;
  commands: ExtensionControlCommand[];
  apiKeys: Partial<Record<LlmProvider, string>>;
  failNextSave: boolean;
  logClears: number;
  shortcutOpens: number;
};

declare global {
  interface Window {
    __popupPreview: PopupPreview;
  }
}

// All configuration, credentials and authorization are isolated in memory.
const params = new URLSearchParams(location.search);
const provider = params.get('state') ?? 'deepseek';
const settings = toExtensionSettingsProjection(structuredClone(defaultExtensionSettings));
settings.translator = provider === 'google' ? 'google_web' : 'llm';
settings.llmProvider = provider === 'google' ? 'deepseek' : (provider as LlmProvider);
settings.debugOptionsExpanded = provider !== 'google' && params.get('debug') !== '0';
settings.showElapsedTime = provider !== 'gemini';
settings.showStageTimingDetails = provider !== 'gemini';
settings.enableDebugLog = provider !== 'google';
if (provider === 'openai') settings.llmProfiles.openai.modelPreset = 'gpt-5.4';
if (provider === 'custom') {
  settings.llmProfiles.custom.customBaseUrl = 'https://api.example.com/v1';
  settings.llmProfiles.custom.modelCustom = 'your-model-name';
}

let projection: ExtensionControlProjection = {
  revision: 1,
  settings,
  access: {
    apiKeys: Object.fromEntries(
      Object.keys(settings.llmProfiles).map((key) => [key, { configured: false }]),
    ) as ExtensionControlProjection['access']['apiKeys'],
    openAiOAuth: { state: 'action-required', availableActions: ['refresh', 'login'] },
    geminiApp: { state: 'ready', availableActions: ['refresh'] },
  },
};
const preview: PopupPreview = {
  getProjection: () => structuredClone(projection),
  commands: [],
  apiKeys: {},
  failNextSave: false,
  logClears: 0,
  shortcutOpens: 0,
};
window.__popupPreview = preview;

const api: ExtensionBrowserApi = {
  runtime: {
    getManifest: () => ({ version: '0.8.3', manifest_version: 3 }),
    getURL: (path) => new URL(path, location.origin).href,
    connect: ({ name } = {}) => ({
      name: name ?? '',
      postMessage() {},
      disconnect() {},
      onMessage: { addListener() {}, removeListener() {} },
      onDisconnect: { addListener() {}, removeListener() {} },
    }),
    sendMessage(message, callback) {
      const request = message as { type: string; command?: ExtensionControlCommand };
      if (request.type === 'mt:diagnostic-log-export') {
        queueMicrotask(() =>
          callback?.({
            ok: true,
            type: request.type,
            log: { eventCount: 1, text: 'popup UI test log', filenamePrefix: 'popup-test-log' },
          }),
        );
        return;
      }
      if (request.type === 'mt:diagnostic-log-clear') {
        preview.logClears += 1;
        queueMicrotask(() => callback?.({ ok: true, type: request.type }));
        return;
      }
      const command = request.command;
      if (!command) throw new Error('Unexpected fixture message');
      preview.commands.push(structuredClone(command));
      if (preview.failNextSave && command.kind === 'replace-settings') {
        preview.failNextSave = false;
        queueMicrotask(() => callback?.({ ok: false, error: '测试保存失败' }));
        return;
      }
      let result: unknown;
      switch (command.kind) {
        case 'replace-settings':
          projection = {
            ...projection,
            revision: projection.revision + 1,
            settings: toExtensionSettingsProjection(normalizeSettings(command.settings)),
          };
          break;
        case 'update-interface-preferences':
          projection = {
            ...projection,
            revision: projection.revision + 1,
            settings: { ...projection.settings, ...command.preferences },
          };
          break;
        case 'replace-api-key':
        case 'clear-api-key':
          preview.apiKeys[command.provider] =
            command.kind === 'replace-api-key' ? command.apiKey : '';
          projection.access.apiKeys[command.provider].configured = Boolean(
            preview.apiKeys[command.provider],
          );
          break;
        case 'reveal-api-key':
          result = {
            kind: 'api-key-disclosure',
            provider: command.provider,
            apiKey: preview.apiKeys[command.provider] ?? '',
          };
          break;
        case 'perform-access': {
          const key = command.target === 'openai-oauth' ? 'openAiOAuth' : 'geminiApp';
          if (command.action === 'login') {
            projection.access[key] = { state: 'ready', availableActions: ['refresh', 'logout'] };
          } else if (command.action === 'logout') {
            projection.access[key] = {
              state: 'action-required',
              availableActions: ['refresh', 'login'],
            };
          }
          break;
        }
        case 'read':
          break;
        default:
          throw new Error(`Unsupported preview command: ${command.kind}`);
      }
      result ??= { kind: 'control-projection', projection: structuredClone(projection) };
      queueMicrotask(() => callback?.({ ok: true, type: 'mt:extension-control', result }));
    },
  },
  commands: {
    getAll(callback) {
      const commands = [
        { name: 'start-screenshot-translate', shortcut: 'Alt+Q' },
        { name: 'translate-hover-target', shortcut: 'Alt+T' },
      ];
      callback?.(commands);
      return Promise.resolve(commands);
    },
  },
  tabs: {
    create() {
      preview.shortcutOpens += 1;
      return Promise.resolve({ id: 1 });
    },
  },
};
Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true });
createRoot(document.getElementById('root')!).render(<App />);
