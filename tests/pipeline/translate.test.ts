import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTranslate } from '../../src/pipeline/translate';
import type { PipelineConfig, TextRegion } from '../../src/types';

const baseConfig: PipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'llm',
  llmProvider: 'openai',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: 'sk-test',
  llmModel: 'gpt-5.4-mini',
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

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runTranslate', () => {
  it('uses single-region structured fallback after batch parse failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse('not json'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({
        regions: [
          {
            id: 'region-1',
            translation: '已经没事了，别哭。',
            columns: ['已经没事了，', '别哭。'],
          },
        ],
      })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTranslate([makeRegion()], baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse('not json'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ regions: [] })))
      .mockResolvedValueOnce(chatResponse('普通译文'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTranslate([makeRegion()], baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(3);
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
});
