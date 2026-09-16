import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exportDiagnosticLog,
  recordDiagnosticLogEvent,
  flushDiagnosticLog,
  clearDiagnosticLog,
  resetDiagnosticLogStateForTests,
} from '../../apps/extension/src/background/diagnostics/logStore';
import type { DiagnosticLogEvent } from '../../packages/diagnostics/src/diagnosticLog';

const diagnosticLogStorageKey = 'mangaTranslate.diagnosticLog';

function createStoredEvent(index: number): DiagnosticLogEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.parse('2026-07-15T00:00:00.000Z') + index).toISOString(),
    level: 'info',
    category: 'pipeline.stage',
    source: { context: 'pipeline-host', module: 'orchestrator.ts' },
    message: `event-${index}`,
  };
}

function requestedStorageKeys(keys: string | string[] | Record<string, unknown>): string[] {
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

function installStorage(initialDiagnosticStore: unknown): Record<string, unknown> {
  const storage: Record<string, unknown> = {
    [diagnosticLogStorageKey]: initialDiagnosticStore,
  };
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: 'test', manifest_version: 2 }),
    },
    storage: {
      local: {
        get(
          keys: string | string[] | Record<string, unknown>,
          callback: (items: Record<string, unknown>) => void,
        ) {
          const items = Object.fromEntries(
            requestedStorageKeys(keys).map((key) => [key, storage[key]]),
          );
          callback(items);
        },
        set(items: Record<string, unknown>, callback: () => void) {
          Object.assign(storage, items);
          callback();
        },
        remove(keys: string | string[], callback: () => void) {
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            delete storage[key];
          }
          callback();
        },
      },
    },
  });
  return storage;
}

afterEach(async () => {
  await resetDiagnosticLogStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnostic log store export', () => {
  it('batches a burst, reads history once, and includes unflushed events in export', async () => {
    const storage = installStorage({ events: [createStoredEvent(0)] });
    const api = (globalThis as unknown as { chrome: { storage: { local: {
      get: (keys: unknown, callback: unknown) => void;
      set: (items: unknown, callback: unknown) => void;
    } } } }).chrome.storage.local;
    const read = vi.spyOn(api, 'get');
    const write = vi.spyOn(api, 'set');
    for (let i = 1; i <= 100; i++) await recordDiagnosticLogEvent(createStoredEvent(i));
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await flushDiagnosticLog();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect((storage[diagnosticLogStorageKey] as { events: unknown[] }).events).toHaveLength(101);
    await recordDiagnosticLogEvent(createStoredEvent(101));
    await flushDiagnosticLog();
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
    await recordDiagnosticLogEvent(createStoredEvent(102));
    expect((await exportDiagnosticLog()).text).toContain('event-102');
  });

  it('saves a pending batch automatically after one second', async () => {
    vi.useFakeTimers();
    const storage = installStorage({ events: [] });
    await recordDiagnosticLogEvent(createStoredEvent(1));
    expect((storage[diagnosticLogStorageKey] as { events: unknown[] }).events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect((storage[diagnosticLogStorageKey] as { events: unknown[] }).events).toHaveLength(1);
  });

  it('does not await stalled storage and orders clear safely against an in-flight flush', async () => {
    const storage = installStorage({ events: [] });
    const api = (globalThis as unknown as { chrome: { storage: { local: {
      set: (items: Record<string, unknown>, callback: () => void) => void;
    } } } }).chrome.storage.local;
    let release!: () => void;
    vi.spyOn(api, 'set').mockImplementationOnce((items, callback) => {
      release = () => { Object.assign(storage, items); callback(); };
    });
    await recordDiagnosticLogEvent(createStoredEvent(1));
    const flushing = flushDiagnosticLog();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await recordDiagnosticLogEvent(createStoredEvent(2));
    const clearing = clearDiagnosticLog();
    await recordDiagnosticLogEvent(createStoredEvent(3));
    release();
    await flushing;
    await clearing;
    const exported = await exportDiagnosticLog();
    expect(exported.text).toContain('event-3');
    expect(exported.text).not.toContain('event-1');
    expect(exported.text).not.toContain('event-2');
  });

  it('keeps events after a failed write and retries without duplicates', async () => {
    installStorage({ events: [] });
    const api = (globalThis as unknown as { chrome: { runtime: { lastError?: { message: string } }; storage: { local: {
      set: (items: Record<string, unknown>, callback: () => void) => void;
    } } } }).chrome;
    vi.spyOn(api.storage.local, 'set').mockImplementationOnce((_items, callback) => {
      api.runtime.lastError = { message: 'storage unavailable' };
      callback();
      api.runtime.lastError = undefined;
    });
    await recordDiagnosticLogEvent(createStoredEvent(1));
    await expect(flushDiagnosticLog()).rejects.toThrow('storage unavailable');
    await recordDiagnosticLogEvent(createStoredEvent(2));
    expect((await exportDiagnosticLog()).eventCount).toBe(2);
  });

  it('bounds both event count and accumulated bytes while keeping recent records', async () => {
    installStorage({ events: [] });
    for (let i = 0; i < 2100; i++) await recordDiagnosticLogEvent(createStoredEvent(i));
    let exported = await exportDiagnosticLog();
    expect(exported.eventCount).toBe(2000);
    expect(exported.text).toContain('event-2099');
    expect(exported.text).toContain('日志已裁剪');
    await clearDiagnosticLog();
    for (let i = 0; i < 90; i++) {
      await recordDiagnosticLogEvent({ ...createStoredEvent(i), data: { samples: Array.from({ length: 20 }, () => '字'.repeat(1000)) } });
    }
    exported = await exportDiagnosticLog();
    expect(exported.eventCount).toBeLessThan(90);
    expect(exported.text).toContain('event-89');
    expect(exported.text).toContain('4 MiB');
  });

  it.each([80, 81, 2000])('exports all %i valid events without a top-level truncation marker', async (eventCount) => {
    const events = Array.from({ length: eventCount }, (_, index) => createStoredEvent(index));
    installStorage({ events });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(eventCount);
    expect(exported.text).toContain('"manifestVersion":2');
    expect(exported.text).toContain('event-0');
    expect(exported.text).toContain(`event-${eventCount - 1}`);
    expect(exported.text).not.toContain('[TRUNCATED_ARRAY:');
  });

  it('keeps a legacy event with a missing timestamp and renders unknown-time', async () => {
    const legacyEvent = {
      ...createStoredEvent(1),
      id: 'legacy-event',
      timestamp: undefined,
      message: 'legacy event without timestamp',
    };
    installStorage({ events: [createStoredEvent(0), legacyEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(2);
    expect(exported.text).toContain(
      '[unknown-time][INF][pipeline-host][no-run][pipeline.stage] orchestrator.ts | legacy event without timestamp',
    );
  });

  it('drops only an unrecoverable event and reports the skipped count', async () => {
    const invalidEvent = {
      ...createStoredEvent(1),
      id: 'invalid-event',
      source: undefined,
      message: 'invalid event should not be exported',
    };
    installStorage({ events: [createStoredEvent(0), invalidEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(1);
    expect(exported.text).toContain('event-0');
    expect(exported.text).not.toContain('invalid event should not be exported');
    expect(exported.text).toContain('日志已裁剪');
    expect(exported.text).toContain('持久化日志中有 1 条事件格式无效，已忽略');
  });

  it('redacts each recovered event while preserving nested data truncation', async () => {
    const imageDataUrl = `data:image/png;base64,${'a'.repeat(120)}`;
    const longPrompt = `请翻译：${'台词'.repeat(7000)}`;
    const sensitiveEvent = {
      ...createStoredEvent(0),
      message: 'Authorization: Bearer abc.def.ghi',
      data: {
        apiKey: 'sk-secret',
        sourceImageUrl: imageDataUrl,
        prompt: longPrompt,
        values: Array.from({ length: 81 }, (_, index) => index),
      },
    };
    installStorage({ events: [sensitiveEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(1);
    expect(exported.text).toContain('Bearer [REDACTED]');
    expect(exported.text).toContain('"apiKey":"[REDACTED]"');
    expect(exported.text).toContain('[IMAGE_DATA_URL_REDACTED:');
    expect(exported.text).toContain('[TRUNCATED:');
    expect(exported.text).toContain('[TRUNCATED_ARRAY:1]');
    expect(exported.text).not.toContain('sk-secret');
    expect(exported.text).not.toContain(imageDataUrl);
    expect(exported.text).not.toContain(longPrompt);
  });

  it('does not mutate storage while reading and writes back the recovered store on the next append', async () => {
    const invalidEvent = {
      ...createStoredEvent(1),
      id: 'invalid-event',
      source: undefined,
    };
    const storage = installStorage({ events: [createStoredEvent(0), invalidEvent] });

    await exportDiagnosticLog();
    expect((storage[diagnosticLogStorageKey] as { events: unknown[] }).events).toHaveLength(2);

    await recordDiagnosticLogEvent(createStoredEvent(2));
    await flushDiagnosticLog();

    const persisted = storage[diagnosticLogStorageKey] as {
      events: DiagnosticLogEvent[];
      truncated?: boolean;
      truncationReason?: string;
    };
    expect(persisted.events.map((event) => event.id)).toEqual(['event-0', 'event-2']);
    expect(persisted.truncated).toBe(true);
    expect(persisted.truncationReason).toContain('持久化日志中有 1 条事件格式无效，已忽略');
  });
});
