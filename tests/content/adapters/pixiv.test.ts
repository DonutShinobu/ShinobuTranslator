import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPixivAdapter } from '../../../apps/extension/src/content/adapters/pixiv';

const artworkId = '147943019';

function originalUrl(pageIndex: number): string {
  return `https://i.pximg.net/img-original/img/2026/08/05/00/00/00/${artworkId}_p${pageIndex}.jpg`;
}

function pageResponse(id = artworkId, pageCount = 12) {
  return {
    error: false,
    message: '',
    body: Array.from({ length: pageCount }, (_, pageIndex) => ({
      urls: {
        original: `https://i.pximg.net/img-original/img/2026/08/05/00/00/00/${id}_p${pageIndex}.jpg`,
      },
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pixivAdapter reading page discovery', () => {
  it('returns every authoritative page when Pixiv only mounts five page links', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => Array.from({ length: 5 }, (_, pageIndex) => ({
        href: originalUrl(pageIndex),
      }))),
    });
    const loadArtworkPages = vi.fn(async () => pageResponse());
    const adapter = createPixivAdapter({ loadArtworkPages });

    const discovery = await adapter.discoverReadingPages?.();

    expect(loadArtworkPages).toHaveBeenCalledWith(
      artworkId,
      expect.any(AbortSignal),
    );
    expect(discovery).toMatchObject({ status: 'complete' });
    if (discovery?.status !== 'complete') throw new Error('Expected complete discovery');
    expect(discovery.pages).toHaveLength(12);
    expect(discovery.pages[0]).toEqual({
      key: `${artworkId}_p0`,
      originalUrl: originalUrl(0),
      pageIndex: 0,
    });
    expect(discovery.pages[11]).toEqual({
      key: `${artworkId}_p11`,
      originalUrl: originalUrl(11),
      pageIndex: 11,
    });
  });

  it('falls back to embedded metadata when the page-list request fails', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) => selector.includes('meta-preload-data')
        ? {
            content: JSON.stringify({
              illust: {
                [artworkId]: {
                  pageCount: 2,
                  urls: { original: originalUrl(0) },
                },
              },
            }),
          }
        : null),
      querySelectorAll: vi.fn(() => [
        { href: originalUrl(0) },
        { href: originalUrl(1) },
      ]),
    });
    const loadArtworkPages = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const adapter = createPixivAdapter({ loadArtworkPages });

    const discovery = await adapter.discoverReadingPages?.();
    const cachedDiscovery = await adapter.discoverReadingPages?.();

    expect(discovery?.status).toBe('complete');
    if (discovery?.status !== 'complete') throw new Error('Expected complete discovery');
    expect(discovery.pages).toHaveLength(2);
    expect(discovery.pages[1]?.originalUrl).toBe(originalUrl(1));
    expect(cachedDiscovery).toBe(discovery);
    expect(loadArtworkPages).toHaveBeenCalledOnce();
  });

  it('does not synthesize unconfirmed page URLs from only pageCount and p0 metadata', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({
        content: JSON.stringify({
          illust: {
            [artworkId]: {
              pageCount: 12,
              urls: { original: originalUrl(0) },
            },
          },
        }),
      })),
      querySelectorAll: vi.fn(() => Array.from({ length: 5 }, (_, pageIndex) => ({
        href: originalUrl(pageIndex),
      }))),
    });
    const adapter = createPixivAdapter({
      loadArtworkPages: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });

    await expect(adapter.discoverReadingPages?.()).resolves.toEqual({
      status: 'incomplete',
      reason: 'request-failed',
    });
  });

  it('fails closed instead of treating the five mounted links as the whole artwork', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => Array.from({ length: 5 }, (_, pageIndex) => ({
        href: originalUrl(pageIndex),
      }))),
    });
    const adapter = createPixivAdapter({
      loadArtworkPages: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    });

    const discovery = await adapter.discoverReadingPages?.();

    expect(discovery).toEqual({
      status: 'incomplete',
      reason: 'request-failed',
    });
  });

  it('deduplicates an in-flight request and caches only its successful result', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    let resolveRequest!: (value: unknown) => void;
    const loadArtworkPages = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    }));
    const adapter = createPixivAdapter({ loadArtworkPages });

    const first = adapter.discoverReadingPages?.();
    const second = adapter.discoverReadingPages?.();

    expect(loadArtworkPages).toHaveBeenCalledOnce();
    resolveRequest(pageResponse());
    await expect(first).resolves.toMatchObject({ status: 'complete' });
    await expect(second).resolves.toMatchObject({ status: 'complete' });
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });
    expect(loadArtworkPages).toHaveBeenCalledOnce();
  });

  it('does not cache failures, so a retry can recover', async () => {
    vi.stubGlobal('location', {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    });
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    const loadArtworkPages = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(pageResponse());
    const adapter = createPixivAdapter({ loadArtworkPages });

    await expect(adapter.discoverReadingPages?.()).resolves.toEqual({
      status: 'incomplete',
      reason: 'request-failed',
    });
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });
    expect(loadArtworkPages).toHaveBeenCalledTimes(2);
  });

  it('aborts the previous request when navigation switches to another artwork', async () => {
    const location = {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    };
    vi.stubGlobal('location', location);
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    const nextArtworkId = '147943020';
    let firstSignal: AbortSignal | undefined;
    const loadArtworkPages = vi.fn((id: string, signal: AbortSignal): Promise<unknown> => {
      if (id === artworkId) {
        firstSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return Promise.resolve(pageResponse(nextArtworkId, 2));
    });
    const adapter = createPixivAdapter({ loadArtworkPages });

    const first = adapter.discoverReadingPages?.();
    location.pathname = `/artworks/${nextArtworkId}`;
    const second = adapter.discoverReadingPages?.();

    expect(firstSignal?.aborted).toBe(true);
    await expect(first).resolves.toEqual({ status: 'incomplete', reason: 'request-failed' });
    await expect(second).resolves.toMatchObject({ status: 'complete' });
    expect(loadArtworkPages).toHaveBeenCalledTimes(2);
  });

  it('clears a successful cache when navigation leaves the artwork', async () => {
    const location = {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    };
    vi.stubGlobal('location', location);
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    const nextArtworkId = '147943020';
    const loadArtworkPages = vi.fn(async (id: string) => {
      if (id === nextArtworkId) throw new Error('temporary failure');
      return pageResponse(artworkId, 2);
    });
    const adapter = createPixivAdapter({ loadArtworkPages });

    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });
    location.pathname = `/artworks/${nextArtworkId}`;
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'incomplete' });
    location.pathname = `/artworks/${artworkId}`;
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });

    expect(loadArtworkPages).toHaveBeenCalledTimes(3);
  });

  it('invalidates navigation state immediately and rejects a stale late response', async () => {
    const location = {
      hostname: 'www.pixiv.net',
      pathname: `/artworks/${artworkId}`,
      hash: '#1',
    };
    vi.stubGlobal('location', location);
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    let resolveFirst!: (value: unknown) => void;
    const loadArtworkPages = vi.fn((id: string): Promise<unknown> => {
      if (loadArtworkPages.mock.calls.length === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(pageResponse(id, 2));
    });
    const adapter = createPixivAdapter({ loadArtworkPages });

    const staleDiscovery = adapter.discoverReadingPages?.();
    location.pathname = '/artworks/147943020';
    expect(adapter.getReadingContextKey?.()).toBe('147943020');
    resolveFirst(pageResponse(artworkId, 2));
    await expect(staleDiscovery).resolves.toMatchObject({ status: 'incomplete' });

    location.pathname = `/artworks/${artworkId}`;
    expect(adapter.getReadingContextKey?.()).toBe(artworkId);
    await expect(adapter.discoverReadingPages?.()).resolves.toMatchObject({ status: 'complete' });
    expect(loadArtworkPages).toHaveBeenCalledTimes(2);
  });
});
