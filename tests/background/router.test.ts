import { describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';
import type { ExtensionSettings } from '../../apps/extension/src/shared/config';
import type { ExtensionMessageSender } from '../../apps/extension/src/shared/extensionRuntime';
import { createDiagnosticEvent } from '../../packages/diagnostics/src/diagnosticLog';
import type { DiagnosticLogEvent } from '../../packages/diagnostics/src/diagnosticLog';
import type { RuntimeMessage } from '../../apps/extension/src/shared/messages';
import { toExtensionSettingsProjection } from '../../apps/extension/src/shared/extensionControl';
import type { ExtensionControlProjection } from '../../apps/extension/src/shared/extensionControl';
import {
  routeBackgroundMessage,
  type BackgroundServices,
} from '../../apps/extension/src/background/messages/router';

type MessageOf<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>;

const sender: ExtensionMessageSender = {
  tab: { id: 7, windowId: 3, url: 'https://example.com/page' },
};
const diagnosticLog = {
  schemaVersion: 1 as const,
  exportedAt: '2026-07-11T00:00:00.000Z',
  filenamePrefix: 'shinobu-diagnostic-log',
  contentType: 'text/plain;charset=utf-8' as const,
  eventCount: 1,
  text: 'diagnostic',
};

function createServices(settings: ExtensionSettings = defaultExtensionSettings): BackgroundServices {
  const controlProjection: ExtensionControlProjection = {
    revision: 3,
    settings: toExtensionSettingsProjection(settings),
    access: {
      apiKeys: Object.fromEntries(
        Object.keys(settings.llmProfiles).map((provider) => [provider, { configured: false }]),
      ) as Record<keyof typeof settings.llmProfiles, { configured: boolean }>,
      openAiOAuth: {
        state: 'action-required' as const,
        availableActions: ['refresh', 'login'],
      },
      geminiApp: {
        state: 'action-required' as const,
        availableActions: ['refresh', 'login'],
      },
    },
  };
  return {
    settings: {
      get: vi.fn(async () => settings),
    },
    extensionControl: {
      handle: vi.fn(async () => ({
        kind: 'control-projection' as const,
        projection: controlProjection,
      })),
    },
    diagnostics: {
      record: vi.fn(async (_event: DiagnosticLogEvent) => {}),
      export: vi.fn(async () => diagnosticLog),
      clear: vi.fn(async () => {}),
    },
    images: {
      download: vi.fn(async (
        request: { imageUrl: string; referrerPolicy?: ReferrerPolicy },
        _sender: ExtensionMessageSender,
      ) => ({
        base64: 'aW1hZ2U=',
        contentType: 'image/png',
        sourceUrl: request.imageUrl,
      })),
      capture: vi.fn(async (_sender: ExtensionMessageSender) => ({
        base64: 'c2NyZWVuc2hvdA==',
        contentType: 'image/png',
        sourceUrl: 'https://example.com/page',
      })),
    },
    providers: {
      llm: vi.fn(async (_message: MessageOf<'mt:llm-chat-completions'>) => ({
        ok: true as const,
        type: 'mt:llm-chat-completions' as const,
        data: { choices: [] },
      })),
      geminiAppImage: vi.fn(async (_message: MessageOf<'mt:gemini-app-image-translate'>) => ({
        ok: true as const,
        type: 'mt:gemini-app-image-translate' as const,
        base64: 'app-image',
        contentType: 'image/png',
        metadata: { modelLabel: 'Gemini App', stageTimings: [] },
      })),
      geminiApiImage: vi.fn(async (_message: MessageOf<'mt:gemini-api-image-translate'>) => ({
        ok: true as const,
        type: 'mt:gemini-api-image-translate' as const,
        base64: 'api-image',
        contentType: 'image/png',
        metadata: { modelLabel: 'Gemini API', stageTimings: [] },
      })),
    },
  };
}

describe('routeBackgroundMessage', () => {
  it('routes extension control commands through the domain transport adapter', async () => {
    const services = createServices();
    const command = { kind: 'read' as const };

    await expect(routeBackgroundMessage({
      type: 'mt:extension-control',
      command,
    }, sender, services)).resolves.toMatchObject({
      ok: true,
      type: 'mt:extension-control',
      result: { kind: 'control-projection' },
    });
    expect(services.extensionControl.handle).toHaveBeenCalledWith(command);
  });

  it('keeps diagnostic writes best-effort and preserves export/clear responses', async () => {
    const services = createServices({ ...defaultExtensionSettings, enableDebugLog: true });
    const event = createDiagnosticEvent({
      level: 'info',
      category: 'pipeline.typeset',
      source: { context: 'content', module: 'test' },
      message: 'event',
    }, 'test-session');

    await expect(routeBackgroundMessage({
      type: 'mt:diagnostic-log-event',
      event,
    }, sender, services)).resolves.toEqual({ ok: true, type: 'mt:diagnostic-log-event' });
    expect(services.diagnostics.record).toHaveBeenCalledWith(event);
    await expect(routeBackgroundMessage({ type: 'mt:diagnostic-log-export' }, sender, services)).resolves.toEqual({
      ok: true,
      type: 'mt:diagnostic-log-export',
      log: diagnosticLog,
    });
    await expect(routeBackgroundMessage({ type: 'mt:diagnostic-log-clear' }, sender, services)).resolves.toEqual({
      ok: true,
      type: 'mt:diagnostic-log-clear',
    });

    vi.mocked(services.diagnostics.record).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(routeBackgroundMessage({
      type: 'mt:diagnostic-log-event',
      event,
    }, sender, services)).resolves.toEqual({ ok: true, type: 'mt:diagnostic-log-event' });
  });

  it('routes image download and capture without changing payload fields', async () => {
    const services = createServices();
    await expect(routeBackgroundMessage({
      type: 'mt:download-image',
      imageUrl: 'https://example.com/image.png',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }, sender, services)).resolves.toEqual({
      ok: true,
      type: 'mt:download-image',
      base64: 'aW1hZ2U=',
      contentType: 'image/png',
      sourceUrl: 'https://example.com/image.png',
    });
    expect(services.images.download).toHaveBeenCalledWith({
      imageUrl: 'https://example.com/image.png',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }, sender);
    await routeBackgroundMessage({ type: 'mt:capture-visible-tab' }, sender, services);
    expect(services.images.capture).toHaveBeenCalledWith(sender);
  });

  it('delegates provider messages and preserves external error identity', async () => {
    const services = createServices();
    const llmMessage: MessageOf<'mt:llm-chat-completions'> = {
      type: 'mt:llm-chat-completions',
      body: { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'test' }] },
    };
    await expect(routeBackgroundMessage(llmMessage, sender, services)).resolves.toMatchObject({
      ok: true,
      type: 'mt:llm-chat-completions',
    });
    const appMessage: MessageOf<'mt:gemini-app-image-translate'> = {
      type: 'mt:gemini-app-image-translate',
      image: { base64: 'image', contentType: 'image/png', filename: 'image.png' },
      preparation: {
        provider: 'gemini-app',
        model: 'nano_banana_pro',
        modelLabel: 'Nano Banana Pro',
        prompt: 'translate',
        authMode: 'cookies_permission',
      },
    };
    await routeBackgroundMessage(appMessage, sender, services);
    expect(services.providers.geminiAppImage).toHaveBeenCalledWith(appMessage);

    const providerError = new Error('provider failed');
    vi.mocked(services.providers.llm).mockRejectedValueOnce(providerError);
    await expect(routeBackgroundMessage(llmMessage, sender, services)).rejects.toBe(providerError);
  });

  it('returns the established unsupported response for content-only messages', async () => {
    await expect(routeBackgroundMessage({
      type: 'mt:context-menu-translate',
    }, sender, createServices())).resolves.toEqual({
      ok: false,
      type: 'mt:context-menu-translate',
      error: '不支持的消息类型',
    });
  });
});
