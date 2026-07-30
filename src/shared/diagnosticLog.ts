import { resolveLlmBaseUrl, resolveLlmModel } from './config';
import type { ExtensionSettings } from './config';
import type { PipelineConfig } from '../types';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  normalizeDiagnosticTimestamp,
  redactDiagnosticValue,
  toDiagnosticError,
  truncateDiagnosticText,
  type DiagnosticLogCategory,
  type DiagnosticLogContext,
  type DiagnosticLogError,
  type DiagnosticLogEvent,
  type DiagnosticLogEventInput,
  type DiagnosticLogLevel,
  type DiagnosticLogSource,
} from '@shinobu/browser-runtime/diagnostic-log';

export {
  createDiagnosticEvent,
  createDiagnosticId,
  normalizeDiagnosticTimestamp,
  redactDiagnosticValue,
  toDiagnosticError,
  truncateDiagnosticText,
};
export type {
  DiagnosticLogCategory,
  DiagnosticLogContext,
  DiagnosticLogError,
  DiagnosticLogEvent,
  DiagnosticLogEventInput,
  DiagnosticLogLevel,
  DiagnosticLogSource,
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
  ocrPostFilter?: PipelineConfig['ocrPostFilter'];
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

const imageDataUrlPattern = /^data:image\/[^;]+;base64,/iu;
const blobUrlPattern = /^blob:/iu;

export function sanitizeDiagnosticUrl(url: string): string {
  if (imageDataUrlPattern.test(url)) {
    return `[IMAGE_DATA_URL_REDACTED:${url.length}]`;
  }
  if (blobUrlPattern.test(url)) {
    return `[BLOB_URL_REDACTED:${url.length}]`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(redactDiagnosticValue(url.split('?')[0] ?? url));
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
    ocrPostFilter: settings.disableOcrPostFilter ? 'off' : 'balanced',
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
    ocrPostFilter: config.ocrPostFilter ?? 'balanced',
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
  const stableErrorCode = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
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
  if (
    stableErrorCode === 'transport-disconnected'
    || stableErrorCode === 'context-unavailable'
    || stableErrorCode === 'serialization-failed'
  ) {
    return {
      kind: 'runtime_message',
      reason: message,
      hints: ['扩展内部通信失败，请检查相关扩展上下文是否仍可用。'],
    };
  }
  return {
    kind: 'unknown',
    reason: message,
    hints: ['未知错误类型，检查 error.name、stack 和相邻事件。'],
  };
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
  const context = event.source?.context ?? 'unknown';
  const run = event.runId ?? 'no-run';
  const moduleName = event.source?.module ?? event.category;
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
