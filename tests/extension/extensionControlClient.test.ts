import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionControlClient,
  rebaseExtensionSettingsProjection,
} from '../../apps/extension/src/popup/extensionControlClient';
import { createExecutionPreparationClient } from '../../apps/extension/src/content/core/translation/executionPreparationClient';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';
import { toExtensionSettingsProjection } from '../../apps/extension/src/shared/extensionControl';
import type { ExtensionControlProjection, ExtensionExecutionSnapshot } from '../../apps/extension/src/shared/extensionControl';
import type { ExtensionPort, ExtensionRuntime } from '../../apps/extension/src/shared/extensionRuntime';

function projection(revision: number): ExtensionControlProjection {
  return {
    revision,
    settings: toExtensionSettingsProjection(defaultExtensionSettings),
    access: {
      apiKeys: Object.fromEntries(
        Object.keys(defaultExtensionSettings.llmProfiles).map((provider) => [provider, { configured: false }]),
      ) as ExtensionControlProjection['access']['apiKeys'],
      openAiOAuth: { state: 'action-required', availableActions: ['refresh', 'login'] },
      geminiApp: { state: 'action-required', availableActions: ['refresh', 'login'] },
    },
  };
}

function fakePort(): ExtensionPort {
  return {
    name: 'mt:extension-control-events',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

describe('ExtensionControlClient', () => {
  it('hides runtime discriminants and carries the latest revision across serialized intents', async () => {
    let revision = 4;
    const sendMessage = vi.fn(async (message: unknown) => {
      const command = (message as { command: { kind: string } }).command;
      if (command.kind !== 'read') revision += 1;
      return {
        ok: true,
        type: 'mt:extension-control',
        result: { kind: 'control-projection', projection: projection(revision) },
      };
    });
    const runtime = {
      sendMessage,
      connect: () => fakePort(),
    } as unknown as ExtensionRuntime;
    const client = createExtensionControlClient(runtime);

    const initial = await client.read();
    await client.replaceSettings({ ...initial.settings, targetLang: 'zh-CHT' });
    await client.clearApiKey('deepseek');

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'mt:extension-control', command: { kind: 'read' } },
      {
        type: 'mt:extension-control',
        command: {
          kind: 'replace-settings',
          settings: { ...initial.settings, targetLang: 'zh-CHT' },
          expectedRevision: 4,
        },
      },
      {
        type: 'mt:extension-control',
        command: { kind: 'clear-api-key', provider: 'deepseek' },
      },
    ]);
  });

  it('advances the settings revision only when the owner adopts a pushed projection', async () => {
    const port = fakePort();
    const sendMessage = vi.fn(async (message: unknown) => {
      const command = (message as { command: { kind: string; expectedRevision?: number } }).command;
      return {
        ok: true,
        type: 'mt:extension-control',
        result: { kind: 'control-projection', projection: projection(command.expectedRevision ?? 4) },
      };
    });
    const runtime = {
      sendMessage,
      connect: () => port,
    } as unknown as ExtensionRuntime;
    const client = createExtensionControlClient(runtime);
    await client.read();
    client.subscribe(() => undefined);
    const pushed = projection(8);
    const listener = vi.mocked(port.onMessage.addListener).mock.calls[0]?.[0];
    listener?.({ type: 'mt:extension-control-changed', projection: pushed }, port);

    await client.replaceSettings(pushed.settings);
    expect((sendMessage.mock.calls.at(-1)?.[0] as {
      command: { expectedRevision: number };
    }).command.expectedRevision).toBe(4);

    client.adoptProjection(pushed);
    await client.replaceSettings(pushed.settings);
    expect((sendMessage.mock.calls.at(-1)?.[0] as {
      command: { expectedRevision: number };
    }).command.expectedRevision).toBe(8);
  });

  it('rebases local edits onto unrelated remote changes after a conflict', () => {
    const base = toExtensionSettingsProjection(defaultExtensionSettings);
    const local = { ...base, targetLang: 'zh-CHT' } as const;
    const remote = {
      ...base,
      showElapsedTime: true,
      llmProfiles: {
        ...base.llmProfiles,
        deepseek: {
          ...base.llmProfiles.deepseek,
          modelPreset: 'remote-model',
        },
      },
    };

    expect(rebaseExtensionSettingsProjection(base, local, remote)).toMatchObject({
      targetLang: 'zh-CHT',
      showElapsedTime: true,
      llmProfiles: { deepseek: { modelPreset: 'remote-model' } },
    });
  });

  it('preserves the settings conflict code returned by the background', async () => {
    const runtime = {
      sendMessage: vi.fn(async () => ({
        ok: false,
        type: 'mt:extension-control',
        error: 'stale settings',
        errorCode: 'extension_settings_conflict',
      })),
      connect: () => fakePort(),
    } as unknown as ExtensionRuntime;

    await expect(createExtensionControlClient(runtime).read()).rejects.toMatchObject({
      code: 'extension_settings_conflict',
    });
  });

  it('exposes API keys only through the dedicated disclosure intent', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      type: 'mt:extension-control',
      result: {
        kind: 'api-key-disclosure',
        provider: 'deepseek',
        apiKey: 'visible-secret',
      },
    }));
    const runtime = {
      sendMessage,
      connect: () => fakePort(),
    } as unknown as ExtensionRuntime;

    await expect(createExtensionControlClient(runtime).revealApiKey('deepseek'))
      .resolves.toBe('visible-secret');
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'mt:extension-control',
      command: { kind: 'reveal-api-key', provider: 'deepseek' },
    });
  });
});

describe('ExecutionPreparationClient', () => {
  it('returns only the execution snapshot to Content', async () => {
    const snapshot: ExtensionExecutionSnapshot = {
      revision: 6,
      kind: 'local-pipeline',
      display: {
        showElapsedTime: false,
        showStageTimingDetails: false,
        showRuntimeStages: false,
        stageTimingCardExpanded: true,
        showTypesetDebug: false,
        showEraseDebug: false,
      },
      diagnosticLogEnabled: false,
      diagnosticSettings: {},
    };
    const sendMessage = vi.fn(async () => ({
      ok: true,
      type: 'mt:extension-control',
      result: { kind: 'execution-snapshot', snapshot },
    }));
    const runtime = { sendMessage } as unknown as ExtensionRuntime;

    await expect(createExecutionPreparationClient(runtime)(new AbortController().signal))
      .resolves.toBe(snapshot);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'mt:extension-control',
      command: { kind: 'prepare-execution' },
    });
  });
});
