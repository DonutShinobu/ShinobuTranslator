import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeImageDownloader } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { setActiveContentSessionId } from '../../../apps/extension/src/shared/contentSession';
import type { RuntimeMessage, RuntimeResponse, sendRuntimeMessage } from '../../../apps/extension/src/shared/messages';

const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 128, 255);
const imageUrl = 'https://pbs.twimg.com/media/image?format=jpg&name=large';
const source = { kind: 'remote-image' as const, url: imageUrl, pageImageUrl: imageUrl };

function harness() {
  vi.stubGlobal('window', { location: { hostname: 'x.com' } });
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ manifest_version: 3 }) } });
  const fetchImage = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(bytes, {
    headers: { 'content-type': 'image/jpeg' },
  }));
  vi.stubGlobal('fetch', fetchImage);
  const sendMessage = vi.fn(async (message: RuntimeMessage): Promise<RuntimeResponse> => {
    if (message.type === 'mt:prepare-page-image-cache') {
      return { ok: true, type: message.type, ruleId: 10000 };
    }
    if (message.type === 'mt:release-page-image-cache') return { ok: true, type: message.type };
    if (message.type === 'mt:download-image') {
      return {
        ok: true, type: message.type, contentType: 'image/png',
        base64: 'ZmFsbGJhY2s=', sourceUrl: message.imageUrl,
      };
    }
    throw new Error(`Unexpected message: ${message.type}`);
  });
  const controller = new AbortController();
  const download = createRuntimeImageDownloader(sendMessage as typeof sendRuntimeMessage);
  return { fetchImage, sendMessage, controller, download };
}

afterEach(() => {
  setActiveContentSessionId(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('X displayed image acquisition', () => {
  it.each(['large', 'orig', '4096x4096', '2048x2048', 'medium', 'small', 'thumb', 'future-size'])('reuses the exact displayed %s URL and releases its rule', async (size) => {
    const h = harness();
    setActiveContentSessionId('session_1');
    const displayed = imageUrl.replace('name=large', `name=${size}`);
    const acquired = await h.download({ ...source, pageImageUrl: displayed }, { signal: h.controller.signal });
    expect(h.fetchImage).toHaveBeenCalledExactlyOnceWith(displayed, expect.objectContaining({
      method: 'GET', mode: 'cors', credentials: 'omit', cache: 'force-cache', redirect: 'error',
    }));
    expect(h.sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'mt:prepare-page-image-cache', imageUrl: displayed, contentSessionId: 'session_1' },
      { type: 'mt:release-page-image-cache', ruleId: 10000, contentSessionId: 'session_1' },
    ]);
    expect(new Uint8Array(await acquired.blob.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
    expect(acquired.file.name).toBe('source.jpg');
  });

  it.each([
    { pageImageUrl: undefined },
    { pageImageUrl: imageUrl.replace('/image?', '/different?') },
    { pageImageUrl: imageUrl.replace('format=jpg', 'format=png') },
    { pageImageUrl: imageUrl.replace('&name=large', '') },
    { pageImageUrl: `${imageUrl}&name=orig` },
    { pageImageUrl: `${imageUrl}#fragment` },
    { pageImageUrl: imageUrl.replace('https:', 'http:') },
    { pageImageUrl: 'blob:https://x.com/translated' },
    { pageImageUrl: imageUrl.replace('pbs.twimg.com', 'pbs.twimg.com.evil.test') },
    { allowedBaseUrl: 'https://pbs.twimg.com/media/' },
  ])('retains background acquisition for an ineligible page source %j', async (override) => {
    const h = harness();
    await h.download({ ...source, ...override }, { signal: h.controller.signal });
    expect(h.fetchImage).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['mt:download-image']);
  });

  it.each(['reader.example', 'x.com.evil.test'])('keeps the fast path inside X (%s)', async (hostname) => {
    const h = harness();
    vi.stubGlobal('window', { location: { hostname } });
    await h.download(source, { signal: h.controller.signal });
    expect(h.fetchImage).not.toHaveBeenCalled();
  });

  it('leaves Firefox MV2 on the existing downloader', async () => {
    const h = harness();
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ manifest_version: 2 }) } });
    await h.download(source, { signal: h.controller.signal });
    expect(h.fetchImage).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['mt:download-image']);
  });

  it('falls back when the Origin-removal rule cannot be installed', async () => {
    const h = harness();
    h.sendMessage.mockResolvedValueOnce({ ok: false, type: 'mt:prepare-page-image-cache', error: 'DNR unavailable' });
    const result = await h.download(source, { signal: h.controller.signal });
    expect(h.fetchImage).not.toHaveBeenCalled();
    expect(await result.blob.text()).toBe('fallback');
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'mt:prepare-page-image-cache', 'mt:download-image',
    ]);
  });

  it.each(['cors-error', 'http-error', 'empty', 'html'])('releases the rule before background fallback (%s)', async (failure) => {
    const h = harness();
    h.fetchImage.mockImplementationOnce(async () => {
      if (failure === 'cors-error') throw new TypeError('Failed to fetch');
      return new Response(failure === 'empty' ? null : '<html>Error</html>', {
        status: failure === 'http-error' ? 403 : 200,
        headers: { 'content-type': failure === 'empty' ? 'image/jpeg' : 'text/html' },
      });
    });
    const result = await h.download(source, { signal: h.controller.signal });
    expect(await result.blob.text()).toBe('fallback');
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'mt:prepare-page-image-cache', 'mt:release-page-image-cache', 'mt:download-image',
    ]);
  });

  it('cleans up a rule installed after cancellation without starting either download', async () => {
    const h = harness();
    h.sendMessage.mockImplementationOnce(async () => {
      h.controller.abort();
      return { ok: true, type: 'mt:prepare-page-image-cache', ruleId: 10000 };
    });
    await expect(h.download(source, { signal: h.controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.fetchImage).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'mt:prepare-page-image-cache', 'mt:release-page-image-cache',
    ]);
  });

  it('aborts an in-flight fetch and cleans up without a background retry', async () => {
    const h = harness();
    h.fetchImage.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      h.controller.abort();
    }));
    await expect(h.download(source, { signal: h.controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'mt:prepare-page-image-cache', 'mt:release-page-image-cache',
    ]);
  });

  it('bounds the page fetch and releases its rule before timeout fallback', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetchImage.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = h.download(source, { signal: h.controller.signal });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await (await pending).blob.text()).toBe('fallback');
    expect(h.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'mt:prepare-page-image-cache', 'mt:release-page-image-cache', 'mt:download-image',
    ]);
  });
});
