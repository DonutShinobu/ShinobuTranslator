import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRuntimeMessage } from '../../apps/extension/src/shared/messages';
import {
  createDirectTextTranslationTransport,
  TextTranslationTransportError,
} from '../../packages/text-translation/src/translators/transport';
import { extensionTextTranslationTransport } from '../../apps/extension/src/shared/textTranslationTransport';

vi.mock('../../apps/extension/src/shared/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/extension/src/shared/messages')>();
  return {
    ...actual,
    sendRuntimeMessage: vi.fn(),
  };
});

const request = {
  body: {
    model: 'model-a',
    messages: [{ role: 'user' as const, content: 'hello' }],
  },
  proxyConfig: {
    provider: 'deepseek' as const,
    authMode: 'api_key' as const,
    baseUrl: 'https://api.example.test/v1/',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('text translation transport Adapters', () => {
  it('keeps extension requests behind runtime messaging', async () => {
    vi.mocked(sendRuntimeMessage).mockResolvedValue({
      ok: true,
      type: 'mt:llm-chat-completions',
      data: { choices: [{ message: { content: '你好' } }] },
    });

    await expect(
      extensionTextTranslationTransport.requestChatCompletion(request),
    ).resolves.toEqual({
      choices: [{ message: { content: '你好' } }],
    });
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mt:llm-chat-completions',
      body: request.body,
      proxyConfig: request.proxyConfig,
    }));
  });

  it('sends Web BYOK requests directly with the task abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '你好' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const transport = createDirectTextTranslationTransport({ apiKey: 'sk-local' });

    await expect(transport.requestChatCompletion({
      ...request,
      signal: controller.signal,
    })).resolves.toEqual({
      choices: [{ message: { content: '你好' } }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-local',
        }),
        cache: 'no-store',
        signal: controller.signal,
      }),
    );
  });

  it('classifies direct HTTP failures without leaking the API key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'invalid credential' },
    }), { status: 401 })));
    const transport = createDirectTextTranslationTransport({ apiKey: 'sk-secret-value' });

    const error = await transport.requestChatCompletion({
      ...request,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TextTranslationTransportError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toContain('invalid credential');
    expect((error as Error).message).not.toContain('sk-secret-value');
  });

  it('retries HTTP 429 and 5xx twice with bounded backoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '你好' } }],
      }), { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const transport = createDirectTextTranslationTransport({
      apiKey: 'sk-local',
      fetchImpl: fetchMock as typeof fetch,
      sleep,
    });

    await expect(transport.requestChatCompletion({
      ...request,
    })).resolves.toEqual({
      choices: [{ message: { content: '你好' } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 0, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000, undefined);
  });

  it('does not retry authentication failures and marks network failures for the pipeline retry owner', async () => {
    const authFetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    const authTransport = createDirectTextTranslationTransport({
      apiKey: 'sk-local',
      fetchImpl: authFetch as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });
    await expect(authTransport.requestChatCompletion({
      ...request,
    })).rejects.toMatchObject({ status: 403 });
    expect(authFetch).toHaveBeenCalledOnce();

    const networkFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const networkTransport = createDirectTextTranslationTransport({
      apiKey: 'sk-local',
      fetchImpl: networkFetch as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });
    await expect(networkTransport.requestChatCompletion({
      ...request,
    })).rejects.toMatchObject({
      name: 'TextTranslationTransportError',
      retryable: true,
    });
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it('does not mark an aborted network request as retryable', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('owner ended', 'AbortError'));
    const aborted = new TypeError('Failed to fetch');
    const networkFetch = vi.fn().mockRejectedValue(aborted);
    const transport = createDirectTextTranslationTransport({
      apiKey: 'sk-local',
      fetchImpl: networkFetch as typeof fetch,
      maxRetries: 0,
    });

    await expect(transport.requestChatCompletion({
      ...request,
      signal: controller.signal,
    })).rejects.toBe(aborted);
  });

  it('marks a connection reset while reading the response body as retryable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: vi.fn().mockRejectedValue(new TypeError('connection reset')),
    });
    const transport = createDirectTextTranslationTransport({
      apiKey: 'sk-local',
      fetchImpl: fetchMock as typeof fetch,
      maxRetries: 0,
    });

    await expect(transport.requestChatCompletion({
      ...request,
    })).rejects.toMatchObject({
      name: 'TextTranslationTransportError',
      status: 200,
      retryable: true,
    });
  });
});
