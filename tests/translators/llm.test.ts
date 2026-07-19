import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmTranslate, llmTranslateRegions } from '../../src/translators/llm';

const testGlobal = globalThis as typeof globalThis & { chrome?: unknown };
const originalChrome = testGlobal.chrome;

type CapturedChatBody = {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  response_format?: {
    type: string;
  };
  reasoning_split?: boolean;
  thinking?: {
    type: string;
  };
};

type CapturedSourceSegment = {
  index: number;
  label: string;
  text: string;
};

type CapturedRegionPayload = Array<{
  id: string;
  direction: 'h' | 'v';
  targetColumns?: number;
  targetLines?: number;
  sourceText: {
    plainText: string;
    textWithBreaks: string;
    readingOrder: 'right-to-left' | 'top-to-bottom';
    columns?: CapturedSourceSegment[];
    lines?: CapturedSourceSegment[];
  };
}>;

function installRuntimeChatCompletionMock(responseContent: string, sentMessages: unknown[]): void {
  testGlobal.chrome = {
    runtime: {
      sendMessage(message: unknown, callback?: (response: unknown) => void): void {
        sentMessages.push(message);
        callback?.({
          ok: true,
          type: 'mt:llm-chat-completions',
          data: {
            choices: [{ message: { content: responseContent } }],
          },
        });
      },
    },
  };
}

function findCapturedChatBody(sentMessages: unknown[]): CapturedChatBody {
  const chatMessage = sentMessages.find(
    (message) => typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mt:llm-chat-completions',
  ) as { body?: unknown } | undefined;
  expect(chatMessage?.body).toBeTruthy();
  return chatMessage?.body as CapturedChatBody;
}

function findRuntimeChatMessages(sentMessages: unknown[]): unknown[] {
  return sentMessages.filter(
    (message) => typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mt:llm-chat-completions',
  );
}

function parsePromptPayload(userContent: string): CapturedRegionPayload {
  const marker = '输入数据：';
  const markerIndex = userContent.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(userContent.slice(markerIndex + marker.length)) as CapturedRegionPayload;
}

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
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock('译文', sentMessages);

    const translated = await llmTranslate({
      provider: 'openai',
      authMode: 'openai_oauth',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      thinkingLevel: 'xhigh',
      from: 'ja',
      to: 'zh-CHS',
      text: 'こんにちは',
    });

    expect(translated).toBe('译文');
    const chatMessage = sentMessages.find(
      (message) => typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mt:llm-chat-completions',
    );
    expect(chatMessage).toMatchObject({
      type: 'mt:llm-chat-completions',
      body: {
        model: 'gpt-5.4-mini',
      },
      proxyConfig: {
        provider: 'openai',
        authMode: 'openai_oauth',
        baseUrl: 'https://api.openai.com/v1',
        thinkingLevel: 'xhigh',
      },
    });
  });

  it('proxies API-key chat completion requests through runtime messaging', async () => {
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock('译文', sentMessages);

    const translated = await llmTranslate({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHS',
      text: 'こんにちは',
    });

    expect(translated).toBe('译文');
    const chatMessages = findRuntimeChatMessages(sentMessages);
    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0]).toMatchObject({
      type: 'mt:llm-chat-completions',
      body: {
        model: 'gpt-5.4-mini',
      },
      proxyConfig: {
        provider: 'openai',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
    const body = findCapturedChatBody(sentMessages);
    expect(body).not.toHaveProperty('temperature');
    expect(body.messages[0].content).toContain('专业漫画本地化译者');
    expect(body.messages[0].content).toContain('不要保留日语倒装语序');
    expect(body.messages[1].content).toContain('先理解完整语义');
    expect(body.messages[1].content).toContain('自然中文表达');
    expect(body.messages[1].content).toContain('视觉断列');
    expect(body.messages[1].content).toContain('不要逐行逐列直译');
  });
});

describe('llmTranslateRegions', () => {
  it('passes the MiniMax-M3 thinking selection to the background adapter', async () => {
    const rawContent = JSON.stringify({
      regions: [{ id: 'region-1', translation: '你好。' }],
    });
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock(rawContent, sentMessages);

    await llmTranslateRegions({
      provider: 'minimax',
      authMode: 'api_key',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M3',
      thinkingLevel: 'off',
      from: 'ja',
      to: 'zh-CHS',
      regions: [{ id: 'region-1', direction: 'h', text: 'こんにちは' }],
    });

    const body = findCapturedChatBody(sentMessages);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('reasoning_split');
    expect(body).not.toHaveProperty('thinking');
    expect(sentMessages).toContainEqual(expect.objectContaining({
      proxyConfig: expect.objectContaining({
        provider: 'minimax',
        thinkingLevel: 'off',
      }),
    }));
    expect(body.messages[0].content).toContain('必须严格输出 JSON');
  });

  it('passes the fixed MiniMax-M2 thinking state to the background adapter', async () => {
    const rawContent = JSON.stringify({
      regions: [{ id: 'region-1', translation: '你好。' }],
    });
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock(rawContent, sentMessages);

    await llmTranslateRegions({
      provider: 'minimax',
      authMode: 'api_key',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7',
      thinkingLevel: 'on',
      from: 'ja',
      to: 'zh-CHS',
      regions: [{ id: 'region-1', direction: 'h', text: 'こんにちは' }],
    });

    const body = findCapturedChatBody(sentMessages);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_split');
    expect(sentMessages).toContainEqual(expect.objectContaining({
      proxyConfig: expect.objectContaining({
        provider: 'minimax',
        thinkingLevel: 'on',
      }),
    }));
  });

  it('does not send thinking settings for a custom MiniMax model', async () => {
    const rawContent = JSON.stringify({
      regions: [{ id: 'region-1', translation: '你好。' }],
    });
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock(rawContent, sentMessages);

    await llmTranslateRegions({
      provider: 'minimax',
      authMode: 'api_key',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-Custom',
      useCustomModel: true,
      from: 'ja',
      to: 'zh-CHS',
      regions: [{ id: 'region-1', direction: 'h', text: 'こんにちは' }],
    });

    const body = findCapturedChatBody(sentMessages);
    expect(body).not.toHaveProperty('reasoning_split');
    expect(body).not.toHaveProperty('thinking');
    expect(sentMessages).toContainEqual(expect.objectContaining({
      proxyConfig: expect.objectContaining({
        useCustomModel: true,
      }),
    }));
  });

  it('sends structured reading-order payload and parses region columns', async () => {
    const rawContent = [
      '```json',
      JSON.stringify({
        regions: [
          {
            id: 'vertical',
            translation: '已经没事了，别哭。',
            columns: ['已经没事了，', '别哭。'],
          },
          {
            id: 'horizontal',
            translation: '喂，我们走吧。',
            columns: ['喂，', '我们走吧。'],
          },
        ],
      }),
      '```',
    ].join('\n');
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock(rawContent, sentMessages);

    const result = await llmTranslateRegions({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHS',
      regions: [
        {
          id: 'vertical',
          direction: 'v',
          targetColumns: 2,
          text: 'もう大丈夫\n泣くな',
        },
        {
          id: 'horizontal',
          direction: 'h',
          targetLines: 2,
          text: 'おい\n行くぞ',
        },
      ],
    });

    expect(result.byId.get('vertical')).toEqual({
      translatedText: '已经没事了，别哭。',
      translatedColumns: ['已经没事了，', '别哭。'],
    });
    expect(result.byId.get('horizontal')).toEqual({
      translatedText: '喂，我们走吧。',
      translatedColumns: ['喂，', '我们走吧。'],
    });
    expect(result.rawContent).toBe(rawContent);

    const body = findCapturedChatBody(sentMessages);
    const chatMessages = findRuntimeChatMessages(sentMessages);
    expect(chatMessages[0]).toMatchObject({
      proxyConfig: {
        provider: 'openai',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('专业漫画本地化译者');
    expect(body.messages[0].content).toContain('不要按日语列顺序逐列直译');
    expect(body.messages[0].content).toContain('columns/lines 是排版分段');

    const userContent = body.messages[1].content;
    expect(userContent).toContain('自然流畅的完整中文译文');
    expect(userContent).toContain('允许跨 column/line 重组语义');
    expect(userContent).toContain('先写完整中文译文，再按 targetColumns 拆成 columns');
    expect(userContent).toContain('标点、语气停顿或短语边界');

    const payload = parsePromptPayload(userContent);
    expect(payload[0]).toMatchObject({
      id: 'vertical',
      direction: 'v',
      targetColumns: 2,
      sourceText: {
        plainText: 'もう大丈夫泣くな',
        textWithBreaks: 'もう大丈夫\n泣くな',
        readingOrder: 'right-to-left',
        columns: [
          { index: 1, label: 'column1', text: 'もう大丈夫' },
          { index: 2, label: 'column2', text: '泣くな' },
        ],
      },
    });
    expect(payload[1]).toMatchObject({
      id: 'horizontal',
      direction: 'h',
      targetLines: 2,
      sourceText: {
        plainText: 'おい行くぞ',
        textWithBreaks: 'おい\n行くぞ',
        readingOrder: 'top-to-bottom',
        lines: [
          { index: 1, label: 'line1', text: 'おい' },
          { index: 2, label: 'line2', text: '行くぞ' },
        ],
      },
    });
  });
});
