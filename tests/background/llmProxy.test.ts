import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LlmChatCompletionHttpError,
  proxyApiKeyChatCompletions,
  resolveLlmChatCompletionsEndpoint,
} from '../../apps/extension/src/background/llmProxy';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';
import type { ExtensionSettings } from '../../apps/extension/src/shared/config';
import type { LlmChatCompletionsProxyConfig } from '../../apps/extension/src/shared/messages';

const deepSeekProxyConfig: LlmChatCompletionsProxyConfig = {
  provider: 'deepseek',
  authMode: 'api_key',
  baseUrl: 'https://api.deepseek.com',
};

function createDeepSeekSettings(apiKey = 'sk-deepseek'): ExtensionSettings {
  return {
    ...defaultExtensionSettings,
    translator: 'llm',
    llmProvider: 'deepseek',
    llmProfiles: {
      ...defaultExtensionSettings.llmProfiles,
      deepseek: {
        ...defaultExtensionSettings.llmProfiles.deepseek,
        authMode: 'api_key',
        apiKey,
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveLlmChatCompletionsEndpoint', () => {
  it('uses the configured provider base URL for chat completions', () => {
    expect(resolveLlmChatCompletionsEndpoint('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });
});

describe('proxyApiKeyChatCompletions', () => {
  it('sends chat completions from the background with the stored API key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyApiKeyChatCompletions(
      createDeepSeekSettings(),
      deepSeekProxyConfig,
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'こんにちは' }],
      },
    );

    expect(response).toEqual({ choices: [{ message: { content: '译文' } }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-deepseek',
        }),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestInit?.body as string)).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: {
        type: 'disabled',
      },
    });
  });

  it('does not send thinking settings for a custom DeepSeek model', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const settings: ExtensionSettings = {
      ...createDeepSeekSettings(),
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          authMode: 'api_key',
          apiKey: 'sk-deepseek',
          modelCustom: 'deepseek-custom',
          useCustomModel: true,
        },
      },
    };

    await proxyApiKeyChatCompletions(
      settings,
      {
        ...deepSeekProxyConfig,
        useCustomModel: true,
      },
      {
        model: 'deepseek-custom',
        messages: [{ role: 'user', content: 'こんにちは' }],
      },
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestInit?.body as string)).not.toHaveProperty('thinking');
  });

  it('maps the selected per-model thinking level into the provider request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await proxyApiKeyChatCompletions(
      createDeepSeekSettings(),
      {
        ...deepSeekProxyConfig,
        thinkingLevel: 'max',
      },
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'こんにちは' }],
      },
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestInit?.body as string)).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('uses the per-run proxy config even when current settings select another provider', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const settings: ExtensionSettings = {
      ...createDeepSeekSettings('sk-deepseek'),
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          authMode: 'api_key',
          apiKey: 'sk-deepseek',
        },
        openai: {
          ...defaultExtensionSettings.llmProfiles.openai,
          authMode: 'openai_oauth',
          apiKey: 'sk-openai',
        },
      },
    };

    await proxyApiKeyChatCompletions(
      settings,
      {
        provider: 'openai',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'こんにちは' }],
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-openai',
        }),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestInit?.body as string)).not.toHaveProperty('thinking');
  });

  it('preserves HTTP status and response body on provider errors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toMatchObject({
      name: 'LlmChatCompletionHttpError',
      status: 429,
      statusText: 'Too Many Requests',
      contentType: 'application/json',
      responseText: '{"error":{"message":"quota exceeded"}}',
      message: 'LLM 翻译请求失败: quota exceeded',
    } satisfies Partial<LlmChatCompletionHttpError>);
  });

  it('keeps HTTP 413 visible even when the provider supplies a detail message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'upstream rejected request' } }), {
        status: 413,
        statusText: 'Payload Too Large',
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: 'LLM 翻译请求失败: HTTP 413: upstream rejected request',
    });
  });

  it('marks provider rejections of a built-in thinking setting as a fatal configuration error', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid reasoning_effort' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        {
          ...deepSeekProxyConfig,
          thinkingLevel: 'max',
        },
        {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toMatchObject({
      name: 'LlmChatCompletionHttpError',
      status: 400,
      errorCode: 'llm_thinking_config',
      message: '当前模型不支持所选思考设置: invalid reasoning_effort',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not mislabel unrelated invalid-request errors as thinking failures', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid response_format schema' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toMatchObject({
      name: 'LlmChatCompletionHttpError',
      status: 400,
      errorCode: undefined,
      message: 'LLM 翻译请求失败: invalid response_format schema',
    });
  });

  it('rejects missing API keys before making a provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const settings = createDeepSeekSettings('');

    await expect(
      proxyApiKeyChatCompletions(
        settings,
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toThrow('LLM 模式需要填写 API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects empty base URLs before making a provider request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        {
          ...deepSeekProxyConfig,
          baseUrl: '',
        },
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'こんにちは' }],
        },
      ),
    ).rejects.toThrow('LLM Base URL 不能为空');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
