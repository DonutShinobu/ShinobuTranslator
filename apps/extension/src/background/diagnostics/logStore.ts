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
const diagnosticLogMaxBytes = 4 * 1024 * 1024;
const diagnosticEventMaxBytes = 128 * 1024;
const diagnosticFlushIntervalMs = 1000;
const eventBytes = new WeakMap<DiagnosticLogEvent, number>();
type BufferedLogState = {
  store?: DiagnosticLogStore;
  pending: DiagnosticLogEvent[];
  dropped: boolean;
  dirty?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
let bufferedLog: BufferedLogState = { pending: [], dropped: false };

function sizeOfEvent(event: DiagnosticLogEvent): number {
  let size = eventBytes.get(event);
  if (size === undefined) {
    size = new TextEncoder().encode(JSON.stringify(event)).length;
    eventBytes.set(event, size);
  }
  return size;
}

function trimEvents(events: DiagnosticLogEvent[]): boolean {
  let bytes = events.reduce((sum, event) => sum + sizeOfEvent(event), 0);
  let removed = 0;
  while (events.length - removed > diagnosticLogMaxEvents || bytes > diagnosticLogMaxBytes) {
    bytes -= sizeOfEvent(events[removed++]);
  }
  if (removed) events.splice(0, removed);
  return removed > 0;
}

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

/** Acknowledge enqueueing, never storage I/O. Call flushDiagnosticLog on export. */
export function recordDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  let normalized = createDiagnosticEvent(event, event.sessionId);
  if (sizeOfEvent(normalized) > diagnosticEventMaxBytes) {
    const summary = Object.fromEntries(Object.entries(normalized.data ?? {}).filter(([key]) => (
      ['durationMs', 'runStatus', 'model', 'provider', 'thinkingDisabled', 'image', 'stageTimings', 'detectedRegionCount'].includes(key)
    )));
    normalized = { ...normalized, data: { ...summary, truncated: true, reason: '单条日志过大，已省略详细数据' } };
    if (sizeOfEvent(normalized) > diagnosticEventMaxBytes) normalized = { ...normalized, data: { truncated: true } };
  }
  const state = bufferedLog;
  state.pending.push(normalized);
  state.dropped = trimEvents(state.pending) || state.dropped;
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flushDiagnosticLog().catch(() => undefined);
    }, diagnosticFlushIntervalMs);
  }
  return Promise.resolve();
}

/** Serialized flushes also order clear/export against any in-flight write. */
export function flushDiagnosticLog(): Promise<void> {
  const state = bufferedLog;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  const flush = async (): Promise<void> => {
    state.store ??= await readDiagnosticLogStore();
    if (!state.pending.length && !state.dirty) return;
    const events = [...state.store.events, ...state.pending];
    const dropped = trimEvents(events) || state.dropped;
    state.store = {
      events,
      truncated: state.store.truncated || dropped,
      truncationReason: dropped
        ? `日志超过 ${diagnosticLogMaxEvents} 条或 4 MiB，已丢弃最早的事件`
        : state.store.truncationReason,
    };
    state.pending.splice(0);
    state.dropped = false;
    // Keep the in-memory snapshot dirty on failure; retry without duplicating
    // events on the next batch/export. Logging never blocks translation.
    state.dirty = true;
    await writeDiagnosticLogStore(state.store);
    state.dirty = false;
  };
  const write = diagnosticLogWriteQueue.then(flush, flush);
  diagnosticLogWriteQueue = write.catch(() => undefined);
  return write;
}

export async function resetDiagnosticLogStateForTests(): Promise<void> {
  if (bufferedLog.timer) clearTimeout(bufferedLog.timer);
  await diagnosticLogWriteQueue.catch(() => undefined);
  bufferedLog = { pending: [], dropped: false };
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
  await flushDiagnosticLog().catch(() => undefined);
  const store = bufferedLog.store ?? { events: [] };
  // Include accepted events even if persistence is temporarily unavailable.
  const exportEvents = [...store.events, ...bufferedLog.pending];
  const exportTruncated = trimEvents(exportEvents) || bufferedLog.dropped;
  const settings = await getSettings();
  const chromeApi = getExtensionApi();
  const manifest = chromeApi?.runtime?.getManifest?.();
  const events = exportEvents;
  const exportedAt = new Date().toISOString();
  const extension = {
    version: manifest?.version,
    manifestVersion: manifest?.manifest_version,
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
      truncated: store.truncated || exportTruncated,
      truncationReason: store.truncationReason,
    }),
  };
}

export async function clearDiagnosticLog(): Promise<void> {
  if (bufferedLog.timer) clearTimeout(bufferedLog.timer);
  // Replace the buffer now. Old writes finish before removal; new writes wait
  // behind removal, so clear cannot resurrect old events or delete new ones.
  bufferedLog = { store: { events: [] }, pending: [], dropped: false };
  const clear = diagnosticLogWriteQueue.then(() => storageRemove(diagnosticLogStorageKey));
  diagnosticLogWriteQueue = clear.catch(() => undefined);
  await clear;
}
