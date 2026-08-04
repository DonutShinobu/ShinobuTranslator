import type { ExtensionSettings } from "../../shared/config";
import { getExtensionApi } from '../../shared/extensionRuntime';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  formatDiagnosticTextLog,
  normalizeDiagnosticTimestamp,
} from '@shinobu/diagnostics';
import { sanitizeExtensionSettings } from '../../shared/diagnosticSettings';
import type {
  DiagnosticLogEvent,
  DiagnosticLogEventInput,
  DiagnosticLogRun,
  DiagnosticLogTextExport,
} from '@shinobu/diagnostics';
import { getSettings } from "../settings/settingsStore";
import {
  storageGet,
  storageRemove,
  storageSet,
} from "../storage/chromeStorage";
import { isRecord } from "../utils";

const diagnosticLogStorageKey = "mangaTranslate.diagnosticLog";
const backgroundDiagnosticSessionId = createDiagnosticId("background-session");
let diagnosticLogWriteQueue: Promise<void> = Promise.resolve();

type DiagnosticLogStore = {
  events: DiagnosticLogEvent[];
  truncated?: boolean;
  truncationReason?: string;
};

const diagnosticLogMaxEvents = 2000;

function normalizeStoredDiagnosticLogEvent(value: unknown): DiagnosticLogEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.level !== 'string' ||
    typeof value.category !== 'string' ||
    !isRecord(value.source) ||
    typeof value.source.context !== 'string' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }

  const timestamp = normalizeDiagnosticTimestamp(value.timestamp, '');
  const normalized = createDiagnosticEvent({
    id: value.id,
    sessionId: value.sessionId,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    timestamp,
    level: value.level as DiagnosticLogEvent['level'],
    category: value.category as DiagnosticLogEvent['category'],
    source: {
      context: value.source.context as DiagnosticLogEvent['source']['context'],
      module: typeof value.source.module === 'string' ? value.source.module : undefined,
    },
    message: value.message,
    data: isRecord(value.data) ? value.data : undefined,
    error: isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error as DiagnosticLogEvent['error']
      : undefined,
  }, value.sessionId);

  // Persisted legacy events may not have a timestamp. Keep the empty value so
  // the readable formatter can show "unknown-time" instead of inventing a new
  // timestamp that would move the event to the latest run.
  normalized.timestamp = timestamp;
  return normalized;
}

function appendTruncationReason(current: unknown, reason: string): string {
  return typeof current === 'string' && current.length > 0
    ? `${current}；${reason}`
    : reason;
}

function normalizeDiagnosticLogStore(value: unknown): DiagnosticLogStore {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return { events: [] };
  }

  const events: DiagnosticLogEvent[] = [];
  let invalidEventCount = 0;
  for (const candidate of value.events) {
    const event = normalizeStoredDiagnosticLogEvent(candidate);
    if (event) {
      events.push(event);
    } else {
      invalidEventCount += 1;
    }
  }

  const invalidEventReason = invalidEventCount > 0
    ? `持久化日志中有 ${invalidEventCount} 条事件格式无效，已忽略`
    : undefined;
  const truncationReason = invalidEventReason
    ? appendTruncationReason(value.truncationReason, invalidEventReason)
    : typeof value.truncationReason === 'string'
      ? value.truncationReason
      : undefined;

  return {
    events,
    truncated: value.truncated === true || invalidEventCount > 0,
    truncationReason,
  };
}

async function readDiagnosticLogStore(): Promise<DiagnosticLogStore> {
  const saved = await storageGet(diagnosticLogStorageKey);
  return normalizeDiagnosticLogStore(saved);
}

async function writeDiagnosticLogStore(store: DiagnosticLogStore): Promise<void> {
  await storageSet(diagnosticLogStorageKey, store);
}

async function appendDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const store = await readDiagnosticLogStore();
  const normalized = createDiagnosticEvent(event, event.sessionId);
  const events = [...store.events, normalized];
  const overflow = Math.max(0, events.length - diagnosticLogMaxEvents);
  const nextEvents = overflow > 0 ? events.slice(overflow) : events;
  await writeDiagnosticLogStore({
    events: nextEvents,
    truncated: store.truncated || overflow > 0,
    truncationReason: overflow > 0 ? `事件数量超过 ${diagnosticLogMaxEvents}，已丢弃最早的 ${overflow} 条` : store.truncationReason,
  });
}

export function recordDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const write = diagnosticLogWriteQueue.then(
    () => appendDiagnosticLogEvent(event),
    () => appendDiagnosticLogEvent(event),
  );
  diagnosticLogWriteQueue = write.catch(() => undefined);
  return write;
}

export function toImageTranslateDiagnosticData(image: { base64: string; contentType: string; filename: string }): Record<string, unknown> {
  return {
    contentType: image.contentType,
    filename: image.filename,
    base64Length: image.base64.length,
  };
}

export async function recordBackgroundDiagnosticLog(
  settings: ExtensionSettings,
  event: DiagnosticLogEventInput,
): Promise<void> {
  if (!settings.enableDebugLog || !event.runId) {
    return;
  }
  try {
    await recordDiagnosticLogEvent(createDiagnosticEvent(event, event.sessionId ?? backgroundDiagnosticSessionId));
  } catch {
    // Diagnostic writes are best-effort and must not affect API requests.
  }
}

export function deriveDiagnosticRuns(events: DiagnosticLogEvent[]): DiagnosticLogRun[] {
  const runs = new Map<string, DiagnosticLogRun>();
  for (const event of events) {
    if (!event.runId) continue;
    const timestamp = normalizeDiagnosticTimestamp(event.timestamp, '');
    const existing = runs.get(event.runId);
    if (!existing) {
      runs.set(event.runId, {
        runId: event.runId,
        startedAt: timestamp,
        status: 'running',
        label: typeof event.data?.label === 'string' ? event.data.label : undefined,
      });
      continue;
    }
    if (timestamp < existing.startedAt) {
      existing.startedAt = timestamp;
    }
    const runStatus = event.data?.runStatus;
    if (runStatus === 'success' || runStatus === 'failed') {
      existing.status = runStatus;
      existing.finishedAt = timestamp;
      existing.error = event.error?.message ?? (typeof event.data?.error === 'string' ? event.data.error : existing.error);
    }
  }
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function exportDiagnosticLog(): Promise<DiagnosticLogTextExport> {
  await diagnosticLogWriteQueue.catch(() => undefined);
  const store = await readDiagnosticLogStore();
  const settings = await getSettings();
  const chromeApi = getExtensionApi();
  const manifest = chromeApi?.runtime?.getManifest?.();
  const events = store.events;
  const exportedAt = new Date().toISOString();
  const extension = {
    version: manifest?.version,
    manifestVersion: 3,
  };
  const environment = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : undefined,
  };
  const activeSettings = sanitizeExtensionSettings(settings);
  const runs = deriveDiagnosticRuns(events);
  return {
    schemaVersion: 1,
    exportedAt,
    filenamePrefix: 'shinobu-diagnostic-log',
    contentType: 'text/plain;charset=utf-8',
    eventCount: events.length,
    text: formatDiagnosticTextLog(events, {
      exportedAt,
      extension,
      environment,
      activeSettings,
      runs,
      truncated: store.truncated,
      truncationReason: store.truncationReason,
    }),
  };
}

export async function clearDiagnosticLog(): Promise<void> {
  await storageRemove(diagnosticLogStorageKey);
}
