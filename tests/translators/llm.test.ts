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

  it('uses localized language names and a faithful Traditional Chinese prompt copy', async () => {
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock('譯文', sentMessages);

    await llmTranslate({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHS',
      text: 'こんにちは',
    });
    await llmTranslate({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'zh-CHS',
      to: 'zh-CHT',
      text: '你好',
    });
    await llmTranslate({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'ko',
      to: 'en',
      text: '안녕하세요',
    });

    const chatMessages = findRuntimeChatMessages(sentMessages) as Array<{ body: CapturedChatBody }>;
    expect(chatMessages).toHaveLength(3);

    const simplifiedBody = chatMessages[0].body;
    expect(simplifiedBody.messages[1].content).toContain('请把以下文本从 日文 翻译成 简体中文。');
    expect(simplifiedBody.messages[1].content).not.toContain('ja');
    expect(simplifiedBody.messages[1].content).not.toContain('zh-CHS');

    const traditionalBody = chatMessages[1].body;
    expect(traditionalBody.messages[0].content).toBe([
      '你是專業漫畫本地化譯者和中文潤色編輯。',
      '你的目標是把台詞改寫成自然、口語化、符合中文漫畫閱讀習慣的譯文。',
      '不要保留日語倒裝語序，不要逐詞直譯，只輸出譯文，不輸出解釋。',
    ].join('\n'));
    expect(traditionalBody.messages[1].content).toBe([
      '請把以下文本從 簡體中文 翻譯成 繁體中文。',
      '請先理解完整語義，再用自然中文表達；必要時可以調整語序、合併或拆分短句。',
      '如果原文包含換行，它可能只是漫畫豎排或橫排的視覺斷列；請把它當作同一段語義處理，不要逐行逐列直譯。',
      '只輸出最終譯文，不要輸出註釋、括號說明或原文。',
      '原文：',
      '你好',
    ].join('\n'));

    const unknownLanguageBody = chatMessages[2].body;
    expect(unknownLanguageBody.messages[1].content).toContain('请把以下文本从 ko 翻译成 en。');
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
    expect(userContent).toContain('请把以下文本从 日文 翻译成 简体中文');
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

  it('uses a faithful Traditional Chinese structured prompt without translating protocol fields', async () => {
    const rawContent = JSON.stringify({
      regions: [{ id: 'region-1', translation: '你好。' }],
    });
    const sentMessages: unknown[] = [];
    installRuntimeChatCompletionMock(rawContent, sentMessages);

    await llmTranslateRegions({
      provider: 'openai',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      from: 'ja',
      to: 'zh-CHT',
      regions: [{ id: 'region-1', direction: 'h', text: 'こんにちは' }],
    });

    const body = findCapturedChatBody(sentMessages);
    expect(body.messages[0].content).toBe([
      '你是專業漫畫本地化譯者和中文潤色編輯。',
      '你會先理解整頁上下文和每個文本框的完整語義，再寫出自然中文譯文。',
      '不要按日語列順序逐列直譯，不要保留日語倒裝語序。',
      'columns/lines 是排版分段，不是逐列逐句對應原文。',
      '必須嚴格輸出 JSON，不得輸出解釋。',
    ].join('\n'));
    expect(body.messages[1].content).toBe([
      '請把以下文本從 日文 翻譯成 繁體中文，並基於整頁上下文保持語氣、稱呼和情緒一致。',
      '輸入是多個文本框。請按輸入順序理解上下文，但每個 region 仍獨立返回。',
      'sourceText.plainText 是去掉換行後的完整原文，用於理解整句語義。',
      'sourceText.textWithBreaks 保留 OCR/視覺換行，用於參考原始斷列或斷行。',
      'sourceText.readingOrder 描述視覺閱讀順序：right-to-left 表示豎排從右到左，top-to-bottom 表示橫排行從上到下。',
      'sourceText.columns/sourceText.lines 是結構化分段數組，格式為 [{"index":1,"label":"column1","text":"..."}]。',
      '返回格式必須是：',
      '{"regions":[{"id":"...","translation":"...","columns":["..."]}]}',
      '規則：',
      '1. regions 數組必須覆蓋所有輸入 id。',
      '2. translation 必須是自然流暢的完整中文譯文，優先符合中文語序和中文漫畫台詞習慣。',
      '3. 翻譯時必須允許跨 column/line 重組語義；不要把每個 column/line 當成必須逐字對應的獨立句子。',
      '4. direction=v 時，先寫完整中文譯文，再按 targetColumns 拆成 columns；columns 按最終豎排顯示的閱讀順序返回。',
      '5. direction=h 時，columns 表示最終橫排行分段，優先接近 targetLines。',
      '6. columns 每段都應是自然中文片段，盡量在標點、語氣停頓或短語邊界斷開。',
      '7. 除 JSON 外不要輸出任何內容。',
      `輸入數據：${JSON.stringify([
        {
          id: 'region-1',
          direction: 'h',
          targetLines: 1,
          sourceText: {
            plainText: 'こんにちは',
            textWithBreaks: 'こんにちは',
            readingOrder: 'top-to-bottom',
          },
        },
      ])}`,
    ].join('\n'));
  });
});
