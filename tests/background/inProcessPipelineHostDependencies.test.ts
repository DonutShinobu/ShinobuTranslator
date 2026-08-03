import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchBackgroundMessage: vi.fn(),
}));

vi.mock('../../src/background/index', () => ({
  dispatchBackgroundMessage: mocks.dispatchBackgroundMessage,
}));

import { createInProcessPipelineHostDependencies } from '../../src/background/localPipeline/inProcessPipelineHostDependencies';

const translationRequest = {
  body: {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user' as const, content: 'source' }],
  },
  proxyConfig: {
    provider: 'deepseek' as const,
    authMode: 'api_key' as const,
    baseUrl: 'https://api.deepseek.com/',
  },
  diagnosticRunId: 'run-in-process',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('in-process Firefox pipeline host dependencies', () => {
  it('routes translation and diagnostics through the background dispatcher without runtime messaging', async () => {
    const runtimeSendMessage = vi.fn(() => {
      throw new Error('runtime self-message must not be used');
    });
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: runtimeSendMessage,
        getURL: (path: string) => `moz-extension://test/${path}`,
      },
    });
    mocks.dispatchBackgroundMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'mt:diagnostic-log-event') {
        return { ok: true, type: 'mt:diagnostic-log-event' };
      }
      return {
        ok: true,
        type: 'mt:llm-chat-completions',
        data: { choices: [{ message: { content: 'translated' } }] },
      };
    });
    const dependencies = createInProcessPipelineHostDependencies();

    await expect(
      dependencies.translationTransport?.requestChatCompletion(translationRequest),
    ).resolves.toEqual({
      choices: [{ message: { content: 'translated' } }],
    });
    await expect(dependencies.diagnostics?.emitAsync({
      runId: 'run-in-process',
      level: 'info',
      category: 'model.runtime',
      source: { context: 'pipeline-host', module: 'test' },
      message: 'detector webgpu',
    })).resolves.toBe(true);

    expect(mocks.dispatchBackgroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mt:llm-chat-completions',
        diagnosticRunId: 'run-in-process',
      }),
      {},
    );
    expect(mocks.dispatchBackgroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mt:diagnostic-log-event',
        event: expect.objectContaining({
          runId: 'run-in-process',
          category: 'model.runtime',
        }),
      }),
      {},
    );
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('preserves permission and retry metadata returned by the background dispatcher', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
      },
    });
    mocks.dispatchBackgroundMessage.mockResolvedValue({
      ok: false,
      type: 'mt:llm-chat-completions',
      error: '使用认证信息需要授权',
      errorCode: 'EXTENSION_PERMISSION_DENIED',
      status: 403,
      retryable: false,
    });
    const dependencies = createInProcessPipelineHostDependencies();

    await expect(
      dependencies.translationTransport?.requestChatCompletion(translationRequest),
    ).rejects.toMatchObject({
      name: 'TextTranslationTransportError',
      message: '使用认证信息需要授权',
      code: 'EXTENSION_PERMISSION_DENIED',
      status: 403,
      retryable: false,
    });
  });
});
