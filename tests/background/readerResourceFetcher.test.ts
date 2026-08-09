import { describe, expect, it, vi } from 'vitest';
import { createReaderResourceFetcher } from '../../apps/extension/src/background/readers/readerResourceFetcher';

function textResponse(text: string, url: string): Response {
  const response = new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json;charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('reader resource fetcher', () => {
  it('loads an in-bound HTTPS text resource without following redirects', async () => {
    const fetchResource = vi.fn(async (url: URL | RequestInfo) => (
      textResponse('{"ok":true}', String(url))
    ));
    const fetcher = createReaderResourceFetcher({ fetchResource });

    await expect(fetcher.fetch({
      url: 'https://cdn.example/books/one/content',
      allowedBaseUrl: 'https://cdn.example/books/one/',
    })).resolves.toEqual({
      text: '{"ok":true}',
      contentType: 'application/json;charset=utf-8',
      sourceUrl: 'https://cdn.example/books/one/content',
    });
    expect(fetchResource).toHaveBeenCalledWith(
      'https://cdn.example/books/one/content',
      expect.objectContaining({
        credentials: 'include',
        redirect: 'error',
        method: 'GET',
      }),
    );
  });

  it('rejects path escapes and cross-origin final responses', async () => {
    const fetchResource = vi.fn(async () => textResponse('{}', 'https://evil.example/content'));
    const fetcher = createReaderResourceFetcher({ fetchResource });

    await expect(fetcher.fetch({
      url: 'https://cdn.example/books/outside/content',
      allowedBaseUrl: 'https://cdn.example/books/one/',
    })).rejects.toThrow(/允许范围/u);
    expect(fetchResource).not.toHaveBeenCalled();

    await expect(fetcher.fetch({
      url: 'https://cdn.example/books/one/content',
      allowedBaseUrl: 'https://cdn.example/books/one/',
    })).rejects.toThrow(/响应地址/u);
  });

  it('cancels an unbounded stream as soon as the byte limit is exceeded', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
        if (pulls === 5) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://cdn.example/books/one/content',
    });
    const fetcher = createReaderResourceFetcher({
      fetchResource: vi.fn(async () => response),
      maximumBytes: 8,
    });

    await expect(fetcher.fetch({
      url: 'https://cdn.example/books/one/content',
      allowedBaseUrl: 'https://cdn.example/books/one/',
    })).rejects.toThrow(/大小上限/u);

    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
  });

  it.each([
    ['HTTP failure', 500, 'https://cdn.example/books/one/content', undefined],
    ['escaped response URL', 200, 'https://evil.example/content', undefined],
    ['declared oversize', 200, 'https://cdn.example/books/one/content', '9'],
  ])('cancels the response body before rejecting an early %s', async (
    _label,
    status,
    responseUrl,
    contentLength,
  ) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (contentLength) headers.set('content-length', contentLength);
    const response = new Response(body, { status, headers });
    Object.defineProperty(response, 'url', { value: responseUrl });
    const fetcher = createReaderResourceFetcher({
      fetchResource: vi.fn(async () => response),
      maximumBytes: 8,
    });

    await expect(fetcher.fetch({
      url: 'https://cdn.example/books/one/content',
      allowedBaseUrl: 'https://cdn.example/books/one/',
    })).rejects.toThrow();

    expect(cancelled).toBe(true);
  });
});
