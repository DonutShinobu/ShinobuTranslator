import { describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../src/shared/config';
import type { ExtensionSettings } from '../../src/shared/config';
import type { ExtensionMessageSender } from '../../src/shared/extensionRuntime';
import { createDiagnosticEvent } from '../../src/shared/diagnosticLog';
import type { DiagnosticLogEvent } from '../../src/shared/diagnosticLog';
import type { RuntimeMessage } from '../../src/shared/messages';
import {
  routeBackgroundMessage,
  type BackgroundServices,
} from '../../src/background/messages/router';

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
  return {
    settings: {
      get: vi.fn(async () => settings),
      set: vi.fn(async (nextSettings) => nextSettings),
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
    openAi: {
      status: vi.fn(async () => ({ authenticated: true, email: 'user@example.com' })),
      login: vi.fn(async () => ({ authenticated: false, pending: true })),
      logout: vi.fn(async () => ({ authenticated: false })),
    },
    geminiAuth: {
      status: vi.fn(async (_settings: ExtensionSettings) => ({ authenticated: true })),
      login: vi.fn(async (_settings: ExtensionSettings) => ({ authenticated: false, pending: true })),
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
  it('routes settings reads and normalized writes with the original response discriminants', async () => {
    const services = createServices();
    const nextSettings = { ...defaultExtensionSettings, targetLang: 'zh-CHT' as const };

    await expect(routeBackgroundMessage({ type: 'mt:get-settings' }, sender, services)).resolves.toEqual({
      ok: true,
      type: 'mt:get-settings',
      settings: defaultExtensionSettings,
    });
    await expect(routeBackgroundMessage({
      type: 'mt:set-settings',
      settings: nextSettings,
    }, sender, services)).resolves.toEqual({
      ok: true,
      type: 'mt:set-settings',
      settings: nextSettings,
    });
    expect(services.settings.set).toHaveBeenCalledWith(nextSettings);
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

  it('routes OAuth and Gemini auth through injected services', async () => {
    const services = createServices();
    await expect(routeBackgroundMessage({ type: 'mt:openai-oauth-status' }, sender, services)).resolves.toMatchObject({
      ok: true,
      type: 'mt:openai-oauth-status',
      status: { authenticated: true },
    });
    await expect(routeBackgroundMessage({ type: 'mt:openai-oauth-login' }, sender, services)).resolves.toMatchObject({
      type: 'mt:openai-oauth-login',
      status: { pending: true },
    });
    await expect(routeBackgroundMessage({ type: 'mt:openai-oauth-logout' }, sender, services)).resolves.toMatchObject({
      type: 'mt:openai-oauth-logout',
      status: { authenticated: false },
    });
    await expect(routeBackgroundMessage({ type: 'mt:gemini-app-auth-status' }, sender, services)).resolves.toMatchObject({
      type: 'mt:gemini-app-auth-status',
      status: { authenticated: true },
    });
    await expect(routeBackgroundMessage({ type: 'mt:gemini-app-auth-login' }, sender, services)).resolves.toMatchObject({
      type: 'mt:gemini-app-auth-login',
      status: { pending: true },
    });
    expect(services.geminiAuth.login).toHaveBeenCalledWith(defaultExtensionSettings);
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
