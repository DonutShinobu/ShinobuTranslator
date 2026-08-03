import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLlmChatCompletions } from '../../src/background/providers/providerService';
import { createInProcessPipelineHostDependencies } from '../../src/background/localPipeline/inProcessPipelineHostDependencies';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provider authentication consent gate', () => {
  it('does not start a provider network request after permission denial or revocation', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', {
      runtime: {},
      commands: {
        openShortcutSettings: async () => undefined,
      },
      storage: {
        local: {
          get(_keys: unknown, callback: (items: Record<string, unknown>) => void) {
            callback({});
          },
        },
      },
      permissions: {
        contains(_request: unknown, callback: (granted: boolean) => void) {
          callback(false);
        },
      },
    });

    await expect(handleLlmChatCompletions({
      type: 'mt:llm-chat-completions',
      body: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
      },
    })).rejects.toMatchObject({ code: 'EXTENSION_PERMISSION_DENIED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the Firefox in-process pipeline transport behind the same permission gate', async () => {
    const fetchSpy = vi.fn();
    const runtimeSendMessage = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: runtimeSendMessage,
        getURL: (path: string) => `moz-extension://test/${path}`,
      },
      commands: {
        openShortcutSettings: async () => undefined,
      },
      storage: {
        local: {
          get(_keys: unknown, callback: (items: Record<string, unknown>) => void) {
            callback({});
          },
        },
      },
      permissions: {
        contains(_request: unknown, callback: (granted: boolean) => void) {
          callback(false);
        },
      },
    });
    const dependencies = createInProcessPipelineHostDependencies();

    await expect(dependencies.translationTransport?.requestChatCompletion({
      body: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
      },
      proxyConfig: {
        provider: 'deepseek',
        authMode: 'api_key',
        baseUrl: 'https://api.deepseek.com/',
      },
      diagnosticRunId: 'run-permission-denied',
    })).rejects.toThrow(/未授予此功能所需的安装权限/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });
});
