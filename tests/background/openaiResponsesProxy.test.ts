import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMocks = vi.hoisted(() => ({
  createOpenAiRequestId: vi.fn(() => 'request-1'),
  readJsonResponse: vi.fn(async (response: Response) => response.json()),
  extractResponseError: vi.fn((data: unknown) => (
    typeof data === 'object'
    && data !== null
    && typeof (data as { error?: { message?: unknown } }).error?.message === 'string'
      ? (data as { error: { message: string } }).error.message
      : null
  )),
}));

vi.mock('../../src/background/openai/oauthService', () => oauthMocks);

import { proxyOpenAiChatCompletions } from '../../src/background/openai/responsesProxy';

const oauthService = {
  getInstallationId: vi.fn(async () => 'installation-1'),
  getValidTokens: vi.fn(async () => ({
    idToken: 'id-token',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    email: null,
    planType: null,
    expiresAt: Date.now() + 60_000,
    lastRefresh: Date.now(),
  })),
  refreshTokens: vi.fn(),
};

beforeEach(() => {
  oauthMocks.createOpenAiRequestId.mockReturnValue('request-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('proxyOpenAiChatCompletions', () => {
  it('marks OAuth rejection of the selected effort as a fatal thinking-configuration error', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'unsupported effort max' } }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(proxyOpenAiChatCompletions(
      {
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'translate' }],
      },
      {
        provider: 'openai',
        authMode: 'openai_oauth',
        baseUrl: 'https://api.openai.com/v1',
        thinkingLevel: 'max',
      },
      oauthService,
    )).rejects.toMatchObject({
      errorCode: 'llm_thinking_config',
      message: '当前模型不支持所选思考设置: unsupported effort max',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTP 413 visible when OAuth responses include a detail message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'upstream rejected request' } }), {
        status: 413,
        statusText: 'Payload Too Large',
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(proxyOpenAiChatCompletions(
      {
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'translate' }],
      },
      {
        provider: 'openai',
        authMode: 'openai_oauth',
        baseUrl: 'https://api.openai.com/v1',
      },
      oauthService,
    )).rejects.toThrow('OpenAI ChatGPT 请求失败: HTTP 413: upstream rejected request');
  });
});
