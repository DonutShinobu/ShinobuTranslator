import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmTranslate } from '../../src/translators/llm';

const testGlobal = globalThis as typeof globalThis & { chrome?: unknown };
const originalChrome = testGlobal.chrome;

afterEach(() => {
  if (originalChrome === undefined) {
    delete testGlobal.chrome;
  } else {
    testGlobal.chrome = originalChrome;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('llmTranslate', () => {
  it('proxies OpenAI OAuth chat completion requests through runtime messaging', async () => {
    let sentMessage: unknown;
    testGlobal.chrome = {
      runtime: {
        sendMessage(message: unknown, callback?: (response: unknown) => void): void {
          sentMessage = message;
          callback?.({
            ok: true,
            type: 'mt:llm-chat-completions',
            data: {
              choices: [{ message: { content: '译文' } }],
            },
          });
        },
      },
    };

    const translated = await llmTranslate({
      provider: 'openai',
      authMode: 'openai_oauth',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHS',
      text: 'こんにちは',
    });

    expect(translated).toBe('译文');
    expect(sentMessage).toMatchObject({
      type: 'mt:llm-chat-completions',
      body: {
        model: 'gpt-5.4-mini',
      },
    });
  });

  it('uses the configured API key for direct OpenAI requests in API key mode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const translated = await llmTranslate({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHS',
      text: 'こんにちは',
    });

    expect(translated).toBe('译文');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.body).toBeTypeOf('string');
    expect(JSON.parse(requestInit?.body as string)).not.toHaveProperty('temperature');
  });
});
