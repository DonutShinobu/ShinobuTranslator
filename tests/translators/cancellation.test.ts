import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageTextTranslationTransport } from '../../apps/extension/src/shared/textTranslationTransport';
import { cancelLlmRequest, runCancelableLlmRequest } from '../../apps/extension/src/background/providers/llmCancellation';
import type { RuntimeMessage, RuntimeResponse } from '../../apps/extension/src/shared/messages';
import { routeBackgroundMessage, type BackgroundServices } from '../../apps/extension/src/background/messages/router';
import { defaultExtensionSettings } from '../../apps/extension/src/shared/config';
import { proxyApiKeyChatCompletions, resetLlmRequestOptimizationStateForTests, getLlmRequestOptimizationSnapshotForTests } from '../../apps/extension/src/background/llmProxy';

afterEach(() => {
  resetLlmRequestOptimizationStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user' as const, content: '翻译' }] };
const proxyConfig = { provider: 'alibaba' as const, authMode: 'api_key' as const, baseUrl: 'https://example.test/v1' };

describe('LLM cancellation across runtime messages', () => {
  it('propagates cancellation through the real transport, router, queue and fetch without debug logging', async () => {
    const settings = {
      ...defaultExtensionSettings,
      llmProfiles: { ...defaultExtensionSettings.llmProfiles, alibaba: { ...defaultExtensionSettings.llmProfiles.alibaba, apiKey: 'test-only' } },
    };
    const services = { providers: {
      async llm(message: Extract<RuntimeMessage, { type: 'mt:llm-chat-completions' }>, signal?: AbortSignal) {
        return { ok: true, type: 'mt:llm-chat-completions', data: await proxyApiKeyChatCompletions(settings, message.proxyConfig!, message.body, signal) };
      },
    } } as BackgroundServices;
    let networkSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
      networkSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => networkSignal.addEventListener('abort', () => reject(networkSignal.reason), { once: true }));
    }));
    const transport = createMessageTextTranslationTransport((message) => routeBackgroundMessage(message, { url: 'chrome-extension://test/offscreen.html' }, services));
    const controller = new AbortController();
    const result = transport.requestChatCompletion({ body, proxyConfig, signal: controller.signal });
    const cancelled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(networkSignal).toBeDefined());
    controller.abort();
    await cancelled;
    await vi.waitFor(() => expect(networkSignal.aborted).toBe(true));
    await vi.waitFor(() => expect(getLlmRequestOptimizationSnapshotForTests()).toMatchObject({ active: 0, queued: 0 }));
  });

  it('sends a matching cancel message and rejects promptly even when the background is stalled', async () => {
    const sent: RuntimeMessage[] = [];
    const send = vi.fn((message: RuntimeMessage): Promise<RuntimeResponse> => {
      sent.push(message);
      return message.type === 'mt:llm-cancel'
        ? Promise.resolve({ ok: true, type: 'mt:llm-cancel' })
        : new Promise(() => {});
    });
    const controller = new AbortController();
    const result = createMessageTextTranslationTransport(send).requestChatCompletion({ body, proxyConfig, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(sent[1]).toEqual({ type: 'mt:llm-cancel', requestId: (sent[0] as { requestId: string }).requestId });
  });

  it('never sends an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const send = vi.fn();
    await expect(createMessageTextTranslationTransport(send).requestChatCompletion({ body, proxyConfig, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });

  it('removes cancellation listeners after a successful result', async () => {
    const controller = new AbortController();
    const send = vi.fn(async (): Promise<RuntimeResponse> => ({ ok: true, type: 'mt:llm-chat-completions', data: { choices: [] } }));
    await createMessageTextTranslationTransport(send).requestChatCompletion({ body, proxyConfig, signal: controller.signal });
    controller.abort();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('only lets the originating document cancel the request', async () => {
    const owner = { tab: { id: 1 }, documentId: 'doc-1', url: 'https://example.test/' };
    let signal!: AbortSignal;
    const result = runCancelableLlmRequest(owner, 'owned-request', (value) => { signal = value; return new Promise(() => {}); });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    cancelLlmRequest({ ...owner, documentId: 'doc-2' }, 'owned-request');
    expect(signal.aborted).toBe(false);
    cancelLlmRequest(owner, 'owned-request');
    expect(signal.aborted).toBe(true);
    await rejected;
  });

  it('handles cancellation arriving before the start message', async () => {
    const run = vi.fn();
    cancelLlmRequest({}, 'early-cancel');
    await expect(runCancelableLlmRequest({}, 'early-cancel', run)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
  });

  it('aborts an unresponsive request after the bounded timeout', async () => {
    vi.useFakeTimers();
    const result = runCancelableLlmRequest({}, 'timeout-request', () => new Promise(() => {}));
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
  });
});
