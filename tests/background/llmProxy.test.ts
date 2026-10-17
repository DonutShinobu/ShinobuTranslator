import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLlmRequestOptimizationSnapshotForTests,
  LlmChatCompletionHttpError,
  proxyApiKeyChatCompletions,
  resetLlmRequestOptimizationStateForTests,
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

function createAlibabaCustomSettings(apiKey = 'sk-alibaba'): ExtensionSettings {
  return {
    ...defaultExtensionSettings,
    translator: 'llm',
    llmProvider: 'custom',
    llmProfiles: {
      ...defaultExtensionSettings.llmProfiles,
      custom: {
        ...defaultExtensionSettings.llmProfiles.custom,
        authMode: 'api_key',
        apiKey,
        modelCustom: 'deepseek-v4-pro',
        useCustomModel: true,
      },
    },
  };
}

afterEach(() => {
  resetLlmRequestOptimizationStateForTests();
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
  it('removes cancelled queued requests and frees active slots even if fetch never settles', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit): Promise<Response> => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const requests = controllers.map((controller, index) => proxyApiKeyChatCompletions(
      createDeepSeekSettings(), deepSeekProxyConfig,
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: `cancel-${index}` }] }, controller.signal,
    ).catch((error) => error));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controllers[3].abort();
    await vi.waitFor(() => expect(getLlmRequestOptimizationSnapshotForTests().queued).toBe(1));
    controllers[0].abort();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls[3][1]?.body).toContain('cancel-4');
    controllers.forEach((controller) => controller.abort());
    await Promise.all(requests);
    await vi.waitFor(() => expect(getLlmRequestOptimizationSnapshotForTests()).toMatchObject({ active: 0, queued: 0, cacheSize: 0, concurrencyLimit: 3 }));
  });

  it('does not abort a shared fetch while another caller still needs it', async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn((_url: unknown, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const first = new AbortController();
    const second = new AbortController();
    const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user' as const, content: 'shared' }] };
    const one = proxyApiKeyChatCompletions(createDeepSeekSettings(), deepSeekProxyConfig, body, first.signal);
    const cancelled = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    const two = proxyApiKeyChatCompletions(createDeepSeekSettings(), deepSeekProxyConfig, body, second.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.abort();
    await cancelled;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    finish(new Response(JSON.stringify({ translation: '共享译文' })));
    await expect(two).resolves.toEqual({ translation: '共享译文' });
  });

  it('does not cache late results from cancelled requests or reuse their in-flight entry', async () => {
    const finishes: Array<(value: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finishes.push(resolve); })));
    const controller = new AbortController();
    const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user' as const, content: 'retry' }] };
    const old = proxyApiKeyChatCompletions(createDeepSeekSettings(), deepSeekProxyConfig, body, controller.signal);
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    controller.abort(); await cancelled;
    const current = proxyApiKeyChatCompletions(createDeepSeekSettings(), deepSeekProxyConfig, body);
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[0](new Response(JSON.stringify({ value: 'stale' })));
    finishes[1](new Response(JSON.stringify({ value: 'fresh' })));
    await expect(current).resolves.toEqual({ value: 'fresh' });
    await expect(proxyApiKeyChatCompletions(createDeepSeekSettings(), deepSeekProxyConfig, body)).resolves.toEqual({ value: 'fresh' });
  });

  it('reuses a successful identical response from the bounded session cache', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '缓存译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const body = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user' as const, content: '同一段原文' }],
    };

    const first = await proxyApiKeyChatCompletions(
      createDeepSeekSettings(),
      deepSeekProxyConfig,
      body,
    );
    const second = await proxyApiKeyChatCompletions(
      createDeepSeekSettings(),
      deepSeekProxyConfig,
      body,
    );

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLlmRequestOptimizationSnapshotForTests().cacheSize).toBe(1);
  });

  it('runs at most three different provider requests concurrently', async () => {
    const resolvers: Array<() => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(() => resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: '译文' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const requests = Array.from({ length: 4 }, (_, index) =>
      proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: `原文 ${index}` }],
        },
      ));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(getLlmRequestOptimizationSnapshotForTests()).toMatchObject({
      active: 3,
      queued: 1,
      concurrencyLimit: 3,
    });

    resolvers.shift()?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all(requests);
  });

  it('drops to one request after HTTP 429 and recovers gradually after successes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'busy' } }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '0',
          },
        },
      ))
      .mockImplementation(async () => new Response(
        JSON.stringify({ choices: [{ message: { content: '译文' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(proxyApiKeyChatCompletions(
      createDeepSeekSettings(),
      deepSeekProxyConfig,
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '触发限流' }],
      },
    )).rejects.toMatchObject({ status: 429 });
    await vi.waitFor(() => expect(getLlmRequestOptimizationSnapshotForTests()).toMatchObject({
      active: 0,
      concurrencyLimit: 1,
    }));

    for (let index = 0; index < 4; index += 1) {
      await proxyApiKeyChatCompletions(
        createDeepSeekSettings(),
        deepSeekProxyConfig,
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: `恢复请求 ${index}` }],
        },
      );
    }
    expect(getLlmRequestOptimizationSnapshotForTests().concurrencyLimit).toBe(2);
  });

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

  it('forces non-thinking mode and a bounded output for every Alibaba custom model', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await proxyApiKeyChatCompletions(
      createAlibabaCustomSettings(),
      {
        provider: 'custom',
        authMode: 'api_key',
        baseUrl: 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        useCustomModel: true,
      },
      {
        model: 'qwen-any-model',
        messages: [{ role: 'user', content: 'こんにちは' }],
        reasoning_effort: 'max',
        thinking: { type: 'enabled' },
      },
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestInit?.body as string)).toEqual({
      model: 'qwen-any-model',
      messages: [{ role: 'user', content: 'こんにちは' }],
      enable_thinking: false,
      max_tokens: 2_048,
    });
  });

  it('classifies Alibaba rejection of the forced thinking setting as fatal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'enable_thinking cannot be disabled' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(proxyApiKeyChatCompletions(
      createAlibabaCustomSettings(),
      {
        provider: 'custom',
        authMode: 'api_key',
        baseUrl: 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
      {
        model: 'thinking-only-model',
        messages: [{ role: 'user', content: 'こんにちは' }],
      },
    )).rejects.toMatchObject({
      status: 400,
      errorCode: 'llm_thinking_config',
    });
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
