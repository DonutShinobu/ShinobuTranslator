import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTranslate } from '../../src/pipeline/translate';
import type { PipelineConfig, TextRegion } from '../../src/types';

const testGlobal = globalThis as typeof globalThis & { chrome?: unknown };
const originalChrome = testGlobal.chrome;

const baseConfig: PipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'llm',
  llmProvider: 'openai',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-5.4-mini',
  llmThinkingLevel: 'off',
  typesetDebug: false,
  eraseDebug: false,
  collectDebugLog: false,
  ocrEngine: 'paddleocr_v6_medium',
  processMode: 'translate',
};

function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: 'region-1',
    box: { x: 0, y: 0, width: 80, height: 120 },
    direction: 'v',
    originalLineCount: 2,
    sourceText: 'もう大丈夫\n泣くな',
    translatedText: '',
    ...overrides,
  };
}

function installRuntimeChatSequence(contents: string[]): unknown[] {
  const sentChatMessages: unknown[] = [];
  const queue = [...contents];
  testGlobal.chrome = {
    runtime: {
      sendMessage(message: unknown, callback?: (response: unknown) => void): void {
        if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mt:llm-chat-completions') {
          sentChatMessages.push(message);
          callback?.({
            ok: true,
            type: 'mt:llm-chat-completions',
            data: {
              choices: [{ message: { content: queue.shift() ?? '' } }],
            },
          });
          return;
        }
        callback?.({ ok: true, type: 'mt:diagnostic-log-event' });
      },
    },
  };
  return sentChatMessages;
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

describe('runTranslate', () => {
  it('passes custom-model state through the LLM request', async () => {
    const sentChatMessages = installRuntimeChatSequence([
      JSON.stringify({
        regions: [{ id: 'region-1', translation: '已经没事了，别哭。' }],
      }),
    ]);

    await runTranslate(
      [makeRegion()],
      {
        ...baseConfig,
        llmProvider: 'minimax',
        llmBaseUrl: 'https://api.minimax.io/v1',
        llmModel: 'MiniMax-Custom',
        llmUseCustomModel: true,
      },
    );

    expect(sentChatMessages[0]).toMatchObject({
      body: {
        model: 'MiniMax-Custom',
      },
      proxyConfig: {
        provider: 'minimax',
        useCustomModel: true,
      },
    });
    expect(sentChatMessages[0]).not.toHaveProperty('body.reasoning_split');
    expect(sentChatMessages[0]).not.toHaveProperty('body.thinking');
  });

  it('uses single-region structured fallback after batch parse failure', async () => {
    const sentChatMessages = installRuntimeChatSequence([
      'not json',
      JSON.stringify({
        regions: [
          {
            id: 'region-1',
            translation: '已经没事了，别哭。',
            columns: ['已经没事了，', '别哭。'],
          },
        ],
      }),
    ]);

    const result = await runTranslate([makeRegion()], baseConfig);

    expect(sentChatMessages).toHaveLength(2);
    expect(result.regions[0]).toMatchObject({
      translatedText: '已经没事了，别哭。',
      translatedColumns: ['已经没事了，', '别哭。'],
    });
    expect(result.translationDebug).toMatchObject({
      llmBatchFailed: true,
      llmBatchHitRegionCount: 0,
      llmFallbackUsed: true,
      llmFallbackRegionCount: 1,
      llmFallbackRequestCount: 1,
    });
  });

  it('falls back to plain single-text translation if structured fallback also fails', async () => {
    const sentChatMessages = installRuntimeChatSequence([
      'not json',
      JSON.stringify({ regions: [] }),
      '普通译文',
    ]);

    const result = await runTranslate([makeRegion()], baseConfig);

    expect(sentChatMessages).toHaveLength(3);
    expect(result.regions[0]).toMatchObject({
      translatedText: '普通译文',
      translatedColumns: undefined,
    });
    expect(result.translationDebug).toMatchObject({
      llmBatchFailed: true,
      llmBatchHitRegionCount: 0,
      llmFallbackUsed: true,
      llmFallbackRegionCount: 1,
      llmFallbackRequestCount: 2,
    });
  });

  it('aborts the whole page after one thinking-configuration rejection', async () => {
    const sentChatMessages: unknown[] = [];
    testGlobal.chrome = {
      runtime: {
        sendMessage(message: unknown, callback?: (response: unknown) => void): void {
          if (
            typeof message === 'object'
            && message !== null
            && (message as { type?: unknown }).type === 'mt:llm-chat-completions'
          ) {
            sentChatMessages.push(message);
            callback?.({
              ok: false,
              type: 'mt:llm-chat-completions',
              error: '当前模型不支持所选思考设置: invalid reasoning_effort',
              errorCode: 'llm_thinking_config',
            });
            return;
          }
          callback?.({ ok: true, type: 'mt:diagnostic-log-event' });
        },
      },
    };

    await expect(runTranslate(
      [
        makeRegion({ id: 'region-1' }),
        makeRegion({ id: 'region-2' }),
      ],
      baseConfig,
    )).rejects.toThrow('当前模型不支持所选思考设置');
    expect(sentChatMessages).toHaveLength(1);
  });
});
