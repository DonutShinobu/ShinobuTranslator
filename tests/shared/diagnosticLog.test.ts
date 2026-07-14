import { describe, expect, it } from 'vitest';

import {
  classifyLlmFetchError,
  formatDiagnosticReadableLog,
  formatDiagnosticReadableLogLines,
  formatDiagnosticTextLog,
  normalizeDiagnosticTimestamp,
  redactDiagnosticValue,
  sanitizeDiagnosticUrl,
  toDiagnosticError,
  type DiagnosticLogEvent,
} from '../../src/shared/diagnosticLog';

describe('formatDiagnosticReadableLog', () => {
  it('formats events in the readable log style', () => {
    const events: DiagnosticLogEvent[] = [
      {
        id: 'event-2',
        sessionId: 'session-1',
        runId: 'run-1',
        timestamp: '2026-06-27T09:28:22.875Z',
        level: 'warn',
        category: 'llm.api',
        source: { context: 'content', module: 'translators/llm.ts' },
        message: 'DeepSeek 请求失败：Failed to fetch',
      },
      {
        id: 'event-1',
        sessionId: 'session-1',
        runId: 'run-1',
        timestamp: '2026-06-27T09:28:21.001Z',
        level: 'info',
        category: 'pipeline.stage',
        source: { context: 'content', module: 'orchestrator.ts' },
        message: '进入阶段：翻译',
      },
    ];

    expect(formatDiagnosticReadableLog(events)).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.001\]\[INF\]\[content\]\[run-1\]\[pipeline\.stage\] orchestrator\.ts \| 进入阶段：翻译\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.875\]\[WRN\]\[content\]\[run-1\]\[llm\.api\] translators\/llm\.ts \| DeepSeek 请求失败：Failed to fetch/,
    );
    expect(formatDiagnosticReadableLogLines(events)).toHaveLength(2);
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('[pipeline.stage] orchestrator.ts | 进入阶段：翻译');
    expect(formatDiagnosticReadableLogLines(events)[1]).toContain('[llm.api] translators/llm.ts | DeepSeek 请求失败：Failed to fetch');
  });

  it('surfaces structured details as compact JSON on readable lines', () => {
    const events: DiagnosticLogEvent[] = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        runId: 'run-1',
        timestamp: '2026-06-27T09:28:22.875Z',
        level: 'info',
        category: 'llm.api',
        source: { context: 'content', module: 'translators/llm.ts' },
        message: 'deepseek LLM 请求完成',
        data: {
          provider: 'deepseek',
          authMode: 'api_key',
          endpoint: 'https://api.deepseek.com/chat/completions',
          model: 'deepseek-v4-flash',
          status: 200,
          durationMs: 1234.4,
          backgroundDirectFetch: true,
          contentDirectFetch: false,
        },
      },
      {
        id: 'event-2',
        sessionId: 'session-1',
        timestamp: '2026-06-27T09:28:23.875Z',
        level: 'info',
        category: 'pipeline.stage',
        source: { context: 'content', module: 'orchestrator.ts' },
        message: '翻译 run 完成',
      },
    ];

    expect(formatDiagnosticReadableLogLines(events)[0]).toContain(
      '"endpoint":"https://api.deepseek.com/chat/completions"',
    );
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('"status":200');
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('"durationMs":1234.4');
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('"backgroundDirectFetch":true');
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('"contentDirectFetch":false');
  });

  it('builds a text export without exposing the top-level events array', () => {
    const events: DiagnosticLogEvent[] = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        runId: 'run-1',
        timestamp: '2026-06-27T09:28:22.875Z',
        level: 'error',
        category: 'llm.api',
        source: { context: 'content', module: 'translators/llm.ts' },
        message: 'DeepSeek 请求失败',
        data: {
          provider: 'deepseek',
          endpoint: 'https://api.deepseek.com/chat/completions',
        },
        error: {
          name: 'TypeError',
          message: 'Failed to fetch',
        },
      },
    ];

    const text = formatDiagnosticTextLog(events, {
      exportedAt: '2026-06-27T09:29:00.000Z',
      extension: { version: '0.6.1', manifestVersion: 3 },
      environment: { language: 'zh-CN' },
      activeSettings: {
        translator: 'llm',
        llmProvider: 'deepseek',
        llmModel: 'deepseek-chat',
        enableDebugLog: true,
      },
      runs: [{
        runId: 'run-1',
        startedAt: '2026-06-27T09:28:22.875Z',
        status: 'failed',
        error: 'Failed to fetch',
      }],
    });

    expect(text).toContain('[app.config] diagnosticLog.ts | 导出 ShinobuTranslator 诊断日志');
    expect(text).toContain('[ERR][content][run-1][llm.api] translators/llm.ts | DeepSeek 请求失败');
    expect(text).toContain('"endpoint":"https://api.deepseek.com/chat/completions"');
    expect(text).toContain('error="Failed to fetch"');
    expect(text).not.toContain('"events":');
  });

  it('does not crash when a persisted event is missing timestamp', () => {
    const events = [
      {
        id: 'event-bad',
        sessionId: 'session-1',
        runId: 'run-1',
        level: 'info',
        category: 'pipeline.stage',
        source: { context: 'content', module: 'orchestrator.ts' },
        message: '旧缓存事件缺少时间戳',
      },
      {
        id: 'event-good',
        sessionId: 'session-1',
        runId: 'run-1',
        timestamp: '2026-06-27T09:28:22.875Z',
        level: 'info',
        category: 'llm.api',
        source: { context: 'content', module: 'translators/llm.ts' },
        message: '正常事件',
      },
    ] as DiagnosticLogEvent[];

    expect(() => formatDiagnosticReadableLogLines(events)).not.toThrow();
    expect(formatDiagnosticReadableLogLines(events)[0]).toContain('[unknown-time]');
  });
});

describe('normalizeDiagnosticTimestamp', () => {
  it('falls back when timestamp is missing', () => {
    expect(normalizeDiagnosticTimestamp(undefined, 'fallback-time')).toBe('fallback-time');
    expect(normalizeDiagnosticTimestamp('2026-06-27T09:28:22.875Z', 'fallback-time')).toBe(
      '2026-06-27T09:28:22.875Z',
    );
  });
});

describe('redactDiagnosticValue', () => {
  it('redacts secrets and bearer tokens', () => {
    const redacted = redactDiagnosticValue({
      apiKey: 'sk-secret',
      headers: {
        Authorization: 'Bearer abc.def.ghi',
      },
      message: 'Authorization: Bearer xyz',
    });

    expect(redacted).toEqual({
      apiKey: '[REDACTED]',
      headers: {
        Authorization: '[REDACTED]',
      },
      message: 'Authorization: Bearer [REDACTED]',
    });
  });

  it('redacts image data URLs and truncates long prompt text', () => {
    const dataUrl = 'data:image/png;base64,' + 'a'.repeat(120);
    const redacted = redactDiagnosticValue({
      sourceImageUrl: dataUrl,
      prompt: '请翻译：' + '台词'.repeat(7000),
    }) as Record<string, string>;

    expect(redacted.sourceImageUrl).toBe(`[IMAGE_DATA_URL_REDACTED:${dataUrl.length}]`);
    expect(redacted.prompt).toContain('[TRUNCATED:');
    expect(redacted.prompt.length).toBeLessThan(dataUrl.length + 12_100);
  });

  it('preserves nested error metadata and protects circular causes', () => {
    const inner = new Error('worker failed') as Error & { code?: string };
    inner.code = 'WORKER_BOOTSTRAP_FAILED';
    const outer = new Error('bubble failed', { cause: inner });
    Object.defineProperty(inner, 'cause', { value: outer, configurable: true });

    const diagnostic = toDiagnosticError(outer);

    expect(diagnostic).toMatchObject({
      name: 'Error',
      message: 'bubble failed',
      cause: {
        code: 'WORKER_BOOTSTRAP_FAILED',
        message: 'worker failed',
        cause: '[CIRCULAR]',
      },
    });
  });
});

describe('sanitizeDiagnosticUrl', () => {
  it('keeps only origin and path and redacts local image URLs', () => {
    expect(sanitizeDiagnosticUrl('https://api.deepseek.com/chat/completions?api_key=secret')).toBe(
      'https://api.deepseek.com/chat/completions',
    );
    expect(sanitizeDiagnosticUrl('data:image/png;base64,aaaa')).toBe('[IMAGE_DATA_URL_REDACTED:26]');
    const blobUrl = 'blob:https://mangaplus.shueisha.tv/12345678-1234-1234-1234-123456789abc';
    expect(sanitizeDiagnosticUrl(blobUrl)).toBe(`[BLOB_URL_REDACTED:${blobUrl.length}]`);
  });
});

describe('classifyLlmFetchError', () => {
  it('classifies Failed to fetch as a network failure', () => {
    const classified = classifyLlmFetchError(new TypeError('Failed to fetch'));

    expect(classified.kind).toBe('network');
    expect(classified.reason).toBe('Failed to fetch');
    expect(classified.hints.join(' ')).toContain('CORS');
  });
});
