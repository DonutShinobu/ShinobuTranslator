import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  disposeAll: vi.fn(async () => undefined),
  disposeSession: vi.fn(async () => undefined),
  runtimeEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/runtime/onnxBridge', () => ({
  createSession: mocks.createSession,
  disposeAll: mocks.disposeAll,
  disposeSession: mocks.disposeSession,
}));

vi.mock('../../src/shared/perfTrace', () => ({
  recordPerfRuntimeEvent: (event: Record<string, unknown>) => mocks.runtimeEvents.push(event),
}));

describe('modelRegistry session cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createSession.mockReset();
    mocks.disposeAll.mockClear();
    mocks.runtimeEvents.length = 0;
  });

  it('deduplicates concurrent creation for one provider and reuses the cache', async () => {
    let resolveCreation!: (value: {
      sessionId: string;
      provider: 'wasm';
      inputNames: string[];
      outputNames: string[];
    }) => void;
    const creation = new Promise<{
      sessionId: string;
      provider: 'wasm';
      inputNames: string[];
      outputNames: string[];
    }>((resolve) => {
      resolveCreation = resolve;
    });
    mocks.createSession.mockReturnValue(creation);
    const registry = await import('../../src/runtime/modelRegistry');

    const first = registry.getModelSession('detector', 'wasm');
    const second = registry.getModelSession('detector', 'wasm');
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    resolveCreation({
      sessionId: 'detector-session',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });

    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    const cached = await registry.getModelSession('detector', 'wasm');

    expect(firstHandle).toBe(secondHandle);
    expect(cached).toBe(firstHandle);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      'detector',
      expect.any(String),
      'wasm',
      undefined,
    );
    expect(mocks.runtimeEvents).not.toContainEqual(expect.objectContaining({
      kind: 'provider-fallback',
    }));
    expect(mocks.runtimeEvents.filter((event) => event.kind === 'session-cache-hit')).toHaveLength(2);

    await registry.disposeAllModelSessions();
    expect(mocks.disposeAll).toHaveBeenCalledTimes(1);
  });

  it('rejects a bridge response that silently substitutes another provider', async () => {
    mocks.createSession.mockResolvedValue({
      sessionId: 'detector-session',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });
    const registry = await import('../../src/runtime/modelRegistry');

    await expect(registry.getModelSession('detector', 'webnn')).rejects.toThrow(
      '请求 webnn，实际 wasm',
    );
  });
});
