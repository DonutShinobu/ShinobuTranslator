import { describe, expect, it } from 'vitest';

import {
  createDiagnosticLogStore,
  type DiagnosticLogStoreService,
} from '../../src/background/diagnostics/logStore';
import { defaultExtensionSettings } from '../../src/shared/config';
import type { DiagnosticLogEvent } from '../../src/shared/diagnosticLog';
import type {
  ExtensionStorage,
  JsonValue,
} from '../../apps/extension/src/capabilities/contracts';

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

let activeStore: DiagnosticLogStoreService;

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function installStorage(initialDiagnosticStore: unknown): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {
    [diagnosticLogStorageKey]: toJsonValue(initialDiagnosticStore),
  };
  const storage: ExtensionStorage = {
    async read(keys) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async write(items) {
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of keys) delete values[key];
    },
  };
  activeStore = createDiagnosticLogStore({
    storage,
    getSettings: async () => defaultExtensionSettings,
    extensionVersion: 'test',
  });
  return values;
}

const exportDiagnosticLog = () => activeStore.export();
const recordDiagnosticLogEvent = (event: DiagnosticLogEvent) => (
  activeStore.record(event)
);

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
      message: 'legacy event without timestamp',
    };
    delete (legacyEvent as Partial<DiagnosticLogEvent>).timestamp;
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
      source: null,
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
      source: null,
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
