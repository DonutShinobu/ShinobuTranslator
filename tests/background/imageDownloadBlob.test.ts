import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE } from '@shinobu/image-pipeline/protocol';
import { createImageDownloader } from '../../apps/extension/src/background/images/imageDownloader';
import {
  routeBackgroundMessage,
  type BackgroundServices,
} from '../../apps/extension/src/background/messages/router';
import {
  createRuntimeImageDownloader,
} from '../../apps/extension/src/content/core/translation/imageTranslationExecution';
import {
  isRuntimeMessage,
  type DownloadImageMessage,
  type RuntimeResponse,
  type sendRuntimeMessage,
} from '../../apps/extension/src/shared/messages';

const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 128, 255);
const source = {
  kind: 'remote-image' as const,
  url: 'https://cdn.example/book/source.jpg',
  referrerPolicy: 'same-origin' as const,
  allowedBaseUrl: 'https://cdn.example/book/',
};
const sender = { documentUrl: 'https://reader.example/chapter', tab: { id: 7 } };
const nativeBlob = Blob;

function response(): Response {
  const result = new Response(Uint8Array.from(bytes).buffer, {
    // The existing signature check, rather than the server header, determines MIME.
    headers: { 'content-type': 'application/octet-stream' },
  });
  Object.defineProperty(result, 'url', { value: 'https://cdn.example/book/source.jpg' });
  return result;
}

function harness(options: {
  transformRequest?: (message: DownloadImageMessage) => DownloadImageMessage;
  transformResponse?: (result: RuntimeResponse, index: number) => RuntimeResponse;
} = {}) {
  const fetchImage = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  const downloader = createImageDownloader({ chromeApi: null, fetchImage });
  const download = vi.fn(downloader.download);
  const services = { images: { download } } as unknown as BackgroundServices;
  const messages: DownloadImageMessage[] = [];
  const sendMessage = vi.fn(async (message: DownloadImageMessage) => {
    messages.push(message);
    const routed = options.transformRequest?.(message) ?? message;
    expect(isRuntimeMessage(routed)).toBe(true);
    const result = await routeBackgroundMessage(routed, sender, services);
    return options.transformResponse?.(result, messages.length - 1) ?? result;
  }) as unknown as typeof sendRuntimeMessage;
  return { fetchImage, downloader, download, messages, sendMessage };
}

afterEach(() => vi.unstubAllGlobals());

describe('download Blob experiment', () => {
  it('keeps the default request and complete Base64 response unchanged', async () => {
    const h = harness();
    const acquired = await createRuntimeImageDownloader(h.sendMessage)(source, { signal: new AbortController().signal });
    expect(h.messages).toEqual([{
      type: 'mt:download-image', imageUrl: source.url,
      referrerPolicy: source.referrerPolicy, allowedBaseUrl: source.allowedBaseUrl,
    }]);
    expect(h.download).toHaveBeenCalledWith({
      imageUrl: source.url, referrerPolicy: source.referrerPolicy,
      allowedBaseUrl: source.allowedBaseUrl,
    }, sender, undefined);
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
    expect(acquired.file.name).toBe('source.jpg');
    expect(acquired.blob.type).toBe('image/jpeg');
  });

  it('uses one real request probe and preserves exact source bytes and MIME', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    const records: Record<string, unknown>[] = [];
    vi.stubGlobal('__shinobuColdStartInitMark', (record: Record<string, unknown>) => records.push(record));
    const h = harness();
    const acquired = await createRuntimeImageDownloader(h.sendMessage)(source, { signal: new AbortController().signal });
    const probe = h.messages[0]!.structuredCloneProbe as Blob;
    expect(probe).toBeInstanceOf(Blob);
    expect(probe.size).toBe(1);
    expect(probe.type).toBe(LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE);
    expect(new Uint8Array(await probe.arrayBuffer())).toEqual(Uint8Array.of(83));
    expect(h.download.mock.calls[0]![0]).toMatchObject({ preferBlob: true });
    expect(h.fetchImage).toHaveBeenCalledOnce();
    expect(h.fetchImage.mock.calls[0]![1]).toMatchObject({
      method: 'GET', credentials: 'include', cache: 'default', redirect: 'error',
    });
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
    expect(acquired.file.type).toBe('image/jpeg');
    expect(records.map(({ phase, transport, bytes: byteCount, base64Length }) => ({
      phase, transport, bytes: byteCount, base64Length,
    }))).toEqual([
      { phase: 'image.download-encode', transport: 'blob', bytes: bytes.length, base64Length: 0 },
      { phase: 'image.download-decode', transport: 'blob', bytes: bytes.length, base64Length: 0 },
    ]);
  });

  it('falls back in one call when a JSON serializer strips the Blob request probe', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    const h = harness({ transformRequest: (message) => ({ ...message, structuredCloneProbe: {} }) });
    const acquired = await createRuntimeImageDownloader(h.sendMessage)(source, { signal: new AbortController().signal });
    expect(h.download.mock.calls[0]![0].preferBlob).toBeUndefined();
    expect(h.messages).toHaveLength(1);
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    undefined, {},
    new nativeBlob([Uint8Array.of(83)], { type: 'application/wrong-probe' }),
    new nativeBlob([Uint8Array.of(83, 83)], { type: LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE }),
  ])('does not authorize Blob from an absent or invalid probe: %s', async (probe) => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    const h = harness();
    const result = await h.sendMessage({
      type: 'mt:download-image', imageUrl: source.url, structuredCloneProbe: probe,
    });
    expect(h.download.mock.calls[0]![0].preferBlob).toBeUndefined();
    expect(result).toMatchObject({ ok: true, base64: '/9j/4AAQgP8=', contentType: 'image/jpeg' });
    expect('blob' in result).toBe(false);
  });

  it('requires the background flag even if the client sends a valid probe', async () => {
    const h = harness();
    await h.sendMessage({
      type: 'mt:download-image', imageUrl: source.url,
      structuredCloneProbe: new Blob([Uint8Array.of(83)], { type: LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE }),
    });
    expect(h.download.mock.calls[0]![0].preferBlob).toBeUndefined();
  });

  it('retries the original request if only the response serializer drops the Blob', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    const h = harness({
      transformResponse: (result, index) => index === 0
        ? { ...result, blob: {} } as unknown as RuntimeResponse
        : result,
    });
    const acquired = await createRuntimeImageDownloader(h.sendMessage)(source, { signal: new AbortController().signal });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]!.structuredCloneProbe).toBeUndefined();
    expect(h.download.mock.calls.map(([request]) => request.preferBlob)).toEqual([true, undefined]);
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
  });

  it('keeps independent transmission modes for queued calls to the same URL across flag changes', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchImage = vi.fn(async () => {
      if (fetchImage.mock.calls.length === 1) {
        started();
        await firstResponse;
      }
      return response();
    });
    const downloader = createImageDownloader({ chromeApi: null, fetchImage });
    const services = { images: { download: downloader.download } } as unknown as BackgroundServices;
    const first = routeBackgroundMessage({
      type: 'mt:download-image', imageUrl: source.url,
      structuredCloneProbe: new Blob([Uint8Array.of(83)], { type: LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE }),
    }, sender, services);
    await fetchStarted;
    vi.stubGlobal('__shinobuColdStartDownloadBlob', false);
    const second = routeBackgroundMessage({ type: 'mt:download-image', imageUrl: source.url }, sender, services);
    expect(fetchImage).toHaveBeenCalledOnce();
    release();
    const [native, legacy] = await Promise.all([first, second]);
    expect(native).toMatchObject({ base64: '', blob: expect.any(nativeBlob) });
    expect(legacy).toMatchObject({ base64: '/9j/4AAQgP8=' });
    expect('blob' in legacy).toBe(false);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('uses Base64 if background Blob materialization is unavailable or throws', async () => {
    const fetched = response();
    const downloader = createImageDownloader({ chromeApi: null, fetchImage: vi.fn(async () => fetched) });
    vi.stubGlobal('Blob', class extends nativeBlob {
      constructor() { super(); throw new Error('Blob unavailable'); }
    });
    await expect(downloader.download({ imageUrl: source.url, preferBlob: true }, sender))
      .resolves.toEqual({ base64: '/9j/4AAQgP8=', contentType: 'image/jpeg', sourceUrl: source.url });
  });

  it('preserves cancellation after an in-flight download instead of decoding or retrying', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    const h = harness({ transformResponse: (result) => ({ ...result, blob: {} } as unknown as RuntimeResponse) });
    const abortController = new AbortController();
    const sendMessage = (async (message: DownloadImageMessage) => {
      const result = await h.sendMessage(message);
      abortController.abort();
      return result;
    }) as typeof sendRuntimeMessage;
    await expect(createRuntimeImageDownloader(sendMessage)(source, { signal: abortController.signal }))
      .rejects.toThrow();
    expect(h.messages).toHaveLength(1);
  });

  it('does not let an observer exception change either transport or the acquired source', async () => {
    vi.stubGlobal('__shinobuColdStartDownloadBlob', true);
    vi.stubGlobal('__shinobuColdStartInitMark', () => { throw new Error('observer failure'); });
    const h = harness();
    const acquired = await createRuntimeImageDownloader(h.sendMessage)(source, { signal: new AbortController().signal });
    expect(new Uint8Array(await acquired.file.arrayBuffer())).toEqual(bytes);
  });
});
