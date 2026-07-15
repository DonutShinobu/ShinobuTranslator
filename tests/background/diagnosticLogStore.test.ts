import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exportDiagnosticLog,
  recordDiagnosticLogEvent,
} from '../../src/background/diagnostics/logStore';
import type { DiagnosticLogEvent } from '../../src/shared/diagnosticLog';

const diagnosticLogStorageKey = 'mangaTranslate.diagnosticLog';

function createStoredEvent(index: number): DiagnosticLogEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.parse('2026-07-15T00:00:00.000Z') + index).toISOString(),
    level: 'info',
    category: 'pipeline.stage',
    source: { context: 'offscreen', module: 'orchestrator.ts' },
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
      getManifest: () => ({ version: 'test' }),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnostic log store export', () => {
  it.each([80, 81, 2000])('exports all %i valid events without a top-level truncation marker', async (eventCount) => {
    const events = Array.from({ length: eventCount }, (_, index) => createStoredEvent(index));
    installStorage({ events });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(eventCount);
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
      '[unknown-time][INF][offscreen][no-run][pipeline.stage] orchestrator.ts | legacy event without timestamp',
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
