import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageEditingPreference } from '../../../apps/extension/src/content/core/editing/imageEditingPreference';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import { toExtensionSettingsProjection, type ExtensionControlProjection } from '../../../apps/extension/src/shared/extensionControl';
import type { ExtensionPort, ExtensionRuntime } from '../../../apps/extension/src/shared/extensionRuntime';

function projection(revision: number, enabled: boolean): ExtensionControlProjection {
  return { revision, settings: toExtensionSettingsProjection({ ...defaultExtensionSettings, enableImageEditing: enabled }),
    access: { apiKeys: {} as ExtensionControlProjection['access']['apiKeys'],
      openAiOAuth: { state: 'ready', availableActions: [] }, geminiApp: { state: 'ready', availableActions: [] } } };
}
afterEach(() => vi.useRealTimers());

describe('live image editing preference', () => {
  it('shares one port, rejects stale reads and releases it after the final image unmounts', async () => {
    let push!: (message: unknown, port: ExtensionPort) => void;
    let resolveRead!: (result: unknown) => void;
    const port: ExtensionPort = { name: 'mt:extension-control-events', postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: { addListener: (fn) => { push = fn; } }, onDisconnect: { addListener: vi.fn() } };
    const runtime = { connect: vi.fn(() => port), sendMessage: () => new Promise((resolve) => { resolveRead = resolve; }) } as unknown as ExtensionRuntime;
    const preference = new ImageEditingPreference(runtime), first = vi.fn(), second = vi.fn();
    const stopFirst = preference.subscribe(first), stopSecond = preference.subscribe(second);
    push({ type: 'mt:extension-control-changed', projection: projection(2, true) }, port);
    resolveRead({ ok: true, type: 'mt:extension-control', result: { kind: 'control-projection', projection: projection(1, false) } });
    await Promise.resolve(); await Promise.resolve();
    expect(first.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
    expect(second.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    stopFirst(); expect(port.disconnect).not.toHaveBeenCalled();
    push({ type: 'mt:extension-control-changed', projection: projection(3, false) }, port);
    expect(second).toHaveBeenLastCalledWith(false);
    stopSecond(); expect(port.disconnect).toHaveBeenCalledTimes(1);
    push({ type: 'mt:extension-control-changed', projection: projection(4, true) }, port);
    expect(second).toHaveBeenCalledTimes(3);
  });
  it('reconnects after a background disconnect and cancels a scheduled reconnect on disposal', async () => {
    vi.useFakeTimers();
    let disconnect!: (port: ExtensionPort) => void;
    const port: ExtensionPort = { name: 'mt:extension-control-events', postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: (fn) => { disconnect = fn; } } };
    const runtime = { connect: vi.fn(() => port), sendMessage: async () => ({ ok: true, type: 'mt:extension-control',
      result: { kind: 'control-projection', projection: projection(1, true) } }) } as unknown as ExtensionRuntime;
    const listener = vi.fn(), stop = new ImageEditingPreference(runtime).subscribe(listener);
    await Promise.resolve(); await Promise.resolve(); expect(listener).toHaveBeenLastCalledWith(true);
    disconnect(port); await vi.advanceTimersByTimeAsync(300); expect(runtime.connect).toHaveBeenCalledTimes(2);
    disconnect(port); stop(); await vi.advanceTimersByTimeAsync(300); expect(runtime.connect).toHaveBeenCalledTimes(2);
  });
});
