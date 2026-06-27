import { resolveLlmBaseUrl, resolveLlmModel, type ExtensionSettings } from './config';
import type { PipelineConfig } from '../types';

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticLogCategory =
  | 'app.config'
  | 'runtime.message'
  | 'pipeline.stage'
  | 'model.runtime'
  | 'pipeline.detect'
  | 'pipeline.ocr'
  | 'pipeline.inpaint'
  | 'pipeline.typeset'
  | 'llm.api'
  | 'image.io'
  | 'chrome.api'
  | 'ui.perf'
  | 'error';

export type DiagnosticLogContext = 'popup' | 'content' | 'background' | 'worker';

export type DiagnosticLogSource = {
  context: DiagnosticLogContext;
  module?: string;
};

export type DiagnosticLogError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export type DiagnosticLogEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  level: DiagnosticLogLevel;
  category: DiagnosticLogCategory;
  source: DiagnosticLogSource;
  message: string;
  data?: Record<string, unknown>;
  error?: DiagnosticLogError;
};

export type DiagnosticLogEventInput = Omit<DiagnosticLogEvent, 'id' | 'sessionId' | 'timestamp'> & {
  id?: string;
  sessionId?: string;
  timestamp?: string;
};

export type DiagnosticLogRunStatus = 'running' | 'success' | 'failed';

export type DiagnosticLogRun = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: DiagnosticLogRunStatus;
  label?: string;
  error?: string;
};

export type SanitizedSettingsSnapshot = {
  translator?: ExtensionSettings['translator'] | PipelineConfig['translator'];
  llmProvider?: ExtensionSettings['llmProvider'] | PipelineConfig['llmProvider'];
  llmAuthMode?: PipelineConfig['llmAuthMode'];
  llmBaseUrl?: string;
  llmModel?: string;
  targetLang?: string;
  processMode?: PipelineConfig['processMode'];
  ocrEngine?: PipelineConfig['ocrEngine'];
  showElapsedTime?: boolean;
  showStageTimingDetails?: boolean;
  showTypesetDebug?: boolean;
  showEraseDebug?: boolean;
  enableDebugLog?: boolean;
  collectDebugLog?: boolean;
};

export type DiagnosticLogEnvironment = {
  userAgent?: string;
  language?: string;
  platform?: string;
  crossOriginIsolated?: boolean;
};

export type DiagnosticLogExtensionInfo = {
  version?: string;
  manifestVersion?: number;
};

export type DiagnosticLogTextExport = {
  schemaVersion: 1;
  exportedAt: string;
  filenamePrefix: string;
  contentType: 'text/plain;charset=utf-8';
  eventCount: number;
  text: string;
};

export type DiagnosticLogTextMetadata = {
  exportedAt: string;
  extension: DiagnosticLogExtensionInfo;
  environment: DiagnosticLogEnvironment;
  activeSettings: SanitizedSettingsSnapshot | null;
  runs: DiagnosticLogRun[];
  truncated?: boolean;
  truncationReason?: string;
};

export type LlmFetchErrorKind =
  | 'network'
  | 'abort'
  | 'http'
  | 'json_parse'
  | 'empty_response'
  | 'runtime_message'
  | 'unknown';

export type LlmFetchErrorClassification = {
  kind: LlmFetchErrorKind;
  reason: string;
  hints: string[];
};

const secretKeyPattern = /(api[_-]?key|authorization|cookie|token|access[_-]?token|refresh[_-]?token|bearer|secret|password|code_verifier|codeVerifier|client_secret)/iu;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const imageDataUrlPattern = /^data:image\/[^;]+;base64,/iu;
const longTextLimit = 12_000;
const maxArrayItems = 80;
const maxObjectKeys = 120;

let fallbackIdCounter = 0;

export function createDiagnosticId(prefix = 'diag'): string {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${(fallbackIdCounter += 1).toString(36)}`;
  return `${prefix}-${randomPart}`;
}

export function normalizeDiagnosticTimestamp(timestamp: unknown, fallback = new Date().toISOString()): string {
  return typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : fallback;
}

export function toDiagnosticError(error: unknown): DiagnosticLogError {
  if (error instanceof Error) {
    return redactDiagnosticValue({
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }) as DiagnosticLogError;
  }
  return {
    message: String(redactDiagnosticValue(error)),
  };
}

export function createDiagnosticEvent(input: DiagnosticLogEventInput, defaultSessionId: string): DiagnosticLogEvent {
  const event: DiagnosticLogEvent = {
    id: input.id ?? createDiagnosticId('event'),
    sessionId: input.sessionId ?? defaultSessionId,
    runId: input.runId,
    timestamp: normalizeDiagnosticTimestamp(input.timestamp),
    level: input.level,
    category: input.category,
    source: {
      context: input.source.context,
      module: input.source.module,
    },
    message: String(redactDiagnosticValue(input.message)),
  };

  if (input.data) {
    event.data = redactDiagnosticValue(input.data) as Record<string, unknown>;
  }
  if (input.error) {
    event.error = redactDiagnosticValue(input.error) as DiagnosticLogError;
  }
  return event;
}

export function redactDiagnosticValue(value: unknown, keyHint = '', depth = 0): unknown {
  if (keyHint && secretKeyPattern.test(keyHint)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return truncateDiagnosticText(redactString(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return toDiagnosticError(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 8) {
      return '[TRUNCATED_DEPTH]';
    }
    const sliced = value.slice(0, maxArrayItems).map((item) => redactDiagnosticValue(item, keyHint, depth + 1));
    if (value.length > maxArrayItems) {
      sliced.push(`[TRUNCATED_ARRAY:${value.length - maxArrayItems}]`);
    }
    return sliced;
  }
  if (typeof value === 'object') {
    if (depth >= 8) {
      return '[TRUNCATED_DEPTH]';
    }
    const out: Record<string, unknown> = {};
    let index = 0;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (index >= maxObjectKeys) {
        out.__truncatedKeys = Object.keys(value as Record<string, unknown>).length - maxObjectKeys;
        break;
      }
      out[key] = redactDiagnosticValue(nested, key, depth + 1);
      index += 1;
    }
    return out;
  }
  return String(value);
}

export function truncateDiagnosticText(text: string, limit = longTextLimit): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...[TRUNCATED:${text.length - limit}]`;
}

export function sanitizeDiagnosticUrl(url: string): string {
  if (imageDataUrlPattern.test(url)) {
    return `[IMAGE_DATA_URL_REDACTED:${url.length}]`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return redactString(url.split('?')[0] ?? url);
  }
}

export function sanitizeExtensionSettings(settings: ExtensionSettings): SanitizedSettingsSnapshot {
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmAuthMode: profile.authMode,
    llmBaseUrl: sanitizeDiagnosticUrl(resolveLlmBaseUrl(settings)),
    llmModel: resolveLlmModel(settings),
    targetLang: settings.targetLang,
    processMode: settings.processMode,
    ocrEngine: settings.ocrEngine,
    showElapsedTime: settings.showElapsedTime,
    showStageTimingDetails: settings.showStageTimingDetails,
    showTypesetDebug: settings.showTypesetDebug,
    showEraseDebug: settings.showEraseDebug,
    enableDebugLog: settings.enableDebugLog,
  };
}

export function sanitizePipelineConfig(config: PipelineConfig): SanitizedSettingsSnapshot {
  return {
    translator: config.translator,
    llmProvider: config.llmProvider,
    llmAuthMode: config.llmAuthMode,
    llmBaseUrl: sanitizeDiagnosticUrl(config.llmBaseUrl),
    llmModel: config.llmModel,
    targetLang: config.targetLang,
    processMode: config.processMode,
    ocrEngine: config.ocrEngine,
    showTypesetDebug: config.typesetDebug,
    showEraseDebug: config.eraseDebug,
    collectDebugLog: config.collectDebugLog,
  };
}

export function formatDiagnosticReadableLogLines(events: DiagnosticLogEvent[]): string[] {
  return [...events]
    .sort((a, b) => getSortableTimestamp(a).localeCompare(getSortableTimestamp(b)))
    .map((event) => formatDiagnosticLogLine(event));
}

export function formatDiagnosticReadableLog(events: DiagnosticLogEvent[]): string {
  return formatDiagnosticReadableLogLines(events).join('\n');
}

export function formatDiagnosticTextLog(events: DiagnosticLogEvent[], metadata: DiagnosticLogTextMetadata): string {
  const lines = [
    formatDiagnosticLogLine({
      timestamp: metadata.exportedAt,
      level: 'info',
      category: 'app.config',
      source: { context: 'background', module: 'diagnosticLog.ts' },
      message: '导出 ShinobuTranslator 诊断日志',
      data: {
        schemaVersion: 1,
        exportedAt: metadata.exportedAt,
        extension: metadata.extension,
        environment: metadata.environment,
        eventCount: events.length,
        runCount: metadata.runs.length,
      },
    }),
  ];

  if (metadata.activeSettings) {
    lines.push(formatDiagnosticLogLine({
      timestamp: metadata.exportedAt,
      level: 'info',
      category: 'app.config',
      source: { context: 'background', module: 'diagnosticLog.ts' },
      message: '当前脱敏设置快照',
      data: { ...metadata.activeSettings },
    }));
  }

  const latestRun = metadata.runs[0];
  if (latestRun) {
    lines.push(formatDiagnosticLogLine({
      timestamp: metadata.exportedAt,
      level: latestRun.status === 'failed' ? 'warn' : 'info',
      category: 'pipeline.stage',
      source: { context: 'background', module: 'diagnosticLog.ts' },
      runId: latestRun.runId,
      message: '最近一次翻译运行',
      data: { ...latestRun },
    }));
  }

  if (metadata.truncated) {
    lines.push(formatDiagnosticLogLine({
      timestamp: metadata.exportedAt,
      level: 'warn',
      category: 'app.config',
      source: { context: 'background', module: 'diagnosticLog.ts' },
      message: '日志已裁剪',
      data: {
        reason: metadata.truncationReason,
      },
    }));
  }

  lines.push(...formatDiagnosticReadableLogLines(events));
  return lines.join('\n');
}

export function classifyLlmFetchError(error: unknown, status?: number): LlmFetchErrorClassification {
  if (typeof status === 'number') {
    return {
      kind: 'http',
      reason: `HTTP ${status}`,
      hints: ['服务端已返回响应，优先检查状态码、响应正文、模型名和 API 额度。'],
    };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      kind: 'abort',
      reason: error.message || '请求被取消或超时',
      hints: ['请求在收到响应前被取消，检查超时、页面卸载或浏览器中断。'],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch/i.test(message) || (error instanceof TypeError && /fetch/i.test(message))) {
    return {
      kind: 'network',
      reason: message,
      hints: [
        '浏览器未拿到 HTTP 响应，常见原因包括 CORS、网络不可达、DNS、代理、证书或扩展上下文无法访问该 endpoint。',
        '检查日志中的 provider、endpoint、contentDirectFetch 和耗时字段。',
      ],
    };
  }
  if (/json/i.test(message) && /parse|unexpected|position/i.test(message)) {
    return {
      kind: 'json_parse',
      reason: message,
      hints: ['服务端响应不是预期 JSON，检查响应体摘要和 content-type。'],
    };
  }
  if (/runtime|sendMessage|扩展通信/i.test(message)) {
    return {
      kind: 'runtime_message',
      reason: message,
      hints: ['扩展内部通信失败，检查 content/background 是否仍存活以及 runtime.lastError。'],
    };
  }
  return {
    kind: 'unknown',
    reason: message,
    hints: ['未知错误类型，检查 error.name、stack 和相邻事件。'],
  };
}

function redactString(value: string): string {
  if (imageDataUrlPattern.test(value)) {
    return `[IMAGE_DATA_URL_REDACTED:${value.length}]`;
  }
  return value.replace(bearerPattern, 'Bearer [REDACTED]');
}

function formatReadableLevel(level: DiagnosticLogLevel): string {
  if (level === 'warn') return 'WRN';
  if (level === 'error') return 'ERR';
  if (level === 'debug') return 'TRC';
  return 'INF';
}

function getSortableTimestamp(event: Pick<DiagnosticLogEvent, 'timestamp'>): string {
  return normalizeDiagnosticTimestamp(event.timestamp, '');
}

function formatReadableTime(timestamp: unknown): string {
  const normalized = normalizeDiagnosticTimestamp(timestamp, 'unknown-time');
  if (normalized === 'unknown-time') {
    return normalized;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return normalized;
  }
  const pad = (value: number, size = 2) => value.toString().padStart(size, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  ].join(' ');
}

function formatDiagnosticLogLine(event: Omit<DiagnosticLogEvent, 'id' | 'sessionId'>): string {
  const time = formatReadableTime(event.timestamp);
  const level = formatReadableLevel(event.level);
  const context = event.source.context;
  const run = event.runId ?? 'no-run';
  const moduleName = event.source.module ?? event.category;
  const parts = [event.message];
  if (event.error?.message) {
    parts.push(`error=${JSON.stringify(event.error.message)}`);
  }
  const details = formatReadableDetails(event);
  if (details) {
    parts.push(details);
  }
  return `[${time}][${level}][${context}][${run}][${event.category}] ${moduleName} | ${parts.join(' ')}`;
}

function formatReadableDetails(event: Omit<DiagnosticLogEvent, 'id' | 'sessionId'>): string {
  const detail: Record<string, unknown> = {};
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      detail[key] = value;
    }
  }
  if (event.error) {
    detail.error = event.error;
  }
  if (Object.keys(detail).length === 0) {
    return '';
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return JSON.stringify({ serializationError: '诊断详情无法序列化' });
  }
}
