import { describe, expect, it, vi } from 'vitest';
import {
  createImageDownloader as createImageDownloaderWithCapabilities,
  type ImageDownloaderDependencies,
} from '../../src/background/images/imageDownloader';
import type {
  DocumentReferrerPolicy,
  DocumentReferrerPolicyObserver,
  ExtensionPermissions,
  ExtensionStorage,
  JsonValue,
  RequestHeaderOverride,
  RequestHeaderOverrideRequest,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  TabDocumentSource,
} from '../../apps/extension/src/capabilities/guards';
import {
  ExtensionOperationError,
} from '../../apps/extension/src/capabilities/errors';

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function createTestSessionStorage(
  initial: Readonly<Record<string, JsonValue>> = {},
): ExtensionStorage {
  const values: Record<string, JsonValue> = { ...initial };
  return {
    async read(keys) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async write(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of keys) delete values[key];
    },
  };
}

type ReferrerPolicyObserverHarness = {
  capability: DocumentReferrerPolicyObserver;
  emit(observation: DocumentReferrerPolicy): void;
};

function createReferrerPolicyObserverHarness(): ReferrerPolicyObserverHarness {
  const listeners = new Set<(observation: DocumentReferrerPolicy) => void>();
  return {
    capability: {
      onObserved(listener) {
        listeners.add(listener);
        let cancelled = false;
        return () => {
          if (cancelled) return;
          cancelled = true;
          listeners.delete(listener);
        };
      },
    },
    emit(observation) {
      for (const listener of listeners) listener(observation);
    },
  };
}

type HeaderOverrideHarness = {
  capability: RequestHeaderOverride;
  requests: RequestHeaderOverrideRequest[];
  releases: Array<ReturnType<typeof vi.fn>>;
  rejectNextAcquire(error?: Error): void;
  rejectNextRelease(error?: Error): void;
  rejectReleaseAttempts(attempts: number, error?: Error): void;
};

function operationError(
  operation: 'acquire' | 'release',
  code: 'browser-rejected' | 'cleanup-failed',
  cause: Error,
): ExtensionOperationError {
  return new ExtensionOperationError({
    capability: 'request-header-override',
    operation,
    code,
    retryable: operation === 'release',
    diagnostic: {
      errorName: cause.name,
    },
    cause,
  });
}

function createHeaderOverrideHarness(): HeaderOverrideHarness {
  const requests: RequestHeaderOverrideRequest[] = [];
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  let acquireFailure: Error | undefined;
  let releaseFailure: Error | undefined;
  let releaseFailuresRemaining = 0;
  return {
    capability: {
      async acquire(request) {
        if (acquireFailure) {
          const failure = acquireFailure;
          acquireFailure = undefined;
          throw operationError('acquire', 'browser-rejected', failure);
        }
        requests.push(request);
        const release = vi.fn(async () => {
          if (!releaseFailure || releaseFailuresRemaining <= 0) return;
          const failure = releaseFailure;
          releaseFailuresRemaining -= 1;
          if (releaseFailuresRemaining === 0) releaseFailure = undefined;
          throw operationError('release', 'cleanup-failed', failure);
        });
        releases.push(release);
        return { release };
      },
    },
    requests,
    releases,
    rejectNextAcquire(error = new Error('header override acquire failed')) {
      acquireFailure = error;
    },
    rejectNextRelease(error = new Error('header override release failed')) {
      releaseFailure = error;
      releaseFailuresRemaining = 1;
    },
    rejectReleaseAttempts(
      attempts,
      error = new Error('header override release failed'),
    ) {
      releaseFailure = error;
      releaseFailuresRemaining = attempts;
    },
  };
}

function documentSource(
  url?: string,
  overrides: Partial<TabDocumentSource> = {},
): TabDocumentSource {
  return {
    kind: 'tab-document',
    documentId: 'document-7',
    tabId: 7,
    frameId: 0,
    ...(url ? { url } : {}),
    ...overrides,
  };
}

function createImageDownloader(
  dependencies: Partial<Omit<ImageDownloaderDependencies, 'sessionStorage'>> & {
    sessionStorage?: ExtensionStorage;
  } = {},
) {
  const observer = createReferrerPolicyObserverHarness();
  const headerOverride = createHeaderOverrideHarness();
  const permissions: ExtensionPermissions = {
    async check() {
      return { status: 'granted' };
    },
    async request() {
      return { status: 'granted' };
    },
    onChanged() {
      return () => undefined;
    },
  };
  return createImageDownloaderWithCapabilities({
    ...dependencies,
    permissions: dependencies.permissions ?? permissions,
    sessionStorage: dependencies.sessionStorage ?? createTestSessionStorage(),
    referrerPolicies: dependencies.referrerPolicies ?? observer.capability,
    requestHeaderOverride: dependencies.requestHeaderOverride ?? headerOverride.capability,
  });
}

function createJpegResponse(
  options: {
    status?: number;
    url?: string;
    contentType?: string;
    bytes?: Uint8Array;
  } = {},
): Response {
  const responseBytes = Uint8Array.from(options.bytes ?? jpegBytes);
  const response = new Response(responseBytes.buffer, {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'image/jpeg' },
  });
  if (options.url) {
    Object.defineProperty(response, 'url', { value: options.url });
  }
  return response;
}

function getRequestedReferer(harness: HeaderOverrideHarness): string | undefined {
  return harness.requests
    .at(-1)
    ?.headers.find((header) => header.name.toLowerCase() === 'referer')
    ?.value;
}

async function observeInstalledReferer(options: {
  targetUrl: string;
  referrerPolicy?: ReferrerPolicy;
  source?: TabDocumentSource;
}): Promise<string | undefined> {
  const headerOverride = createHeaderOverrideHarness();
  const downloader = createImageDownloader({
    requestHeaderOverride: headerOverride.capability,
    fetchImage: vi.fn(async () => createJpegResponse()),
  });
  await downloader.download({
    imageUrl: options.targetUrl,
    referrerPolicy: options.referrerPolicy,
  }, options.source ?? documentSource(
    'https://user:password@reader.example/chapter/1?mode=web#page-2',
  ));
  return getRequestedReferer(headerOverride);
}

const fullSourceReferrer = 'https://reader.example/chapter/1?mode=web';
const sourceOriginReferrer = 'https://reader.example/';
const referrerPolicyMatrix: Array<{
  name: string;
  policy?: ReferrerPolicy;
  sameOrigin: string | undefined;
  crossOrigin: string | undefined;
  downgrade: string | undefined;
}> = [
  {
    name: 'browser default',
    sameOrigin: fullSourceReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: undefined,
  },
  {
    name: 'empty policy',
    policy: '',
    sameOrigin: fullSourceReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: undefined,
  },
  {
    name: 'no-referrer',
    policy: 'no-referrer',
    sameOrigin: undefined,
    crossOrigin: undefined,
    downgrade: undefined,
  },
  {
    name: 'no-referrer-when-downgrade',
    policy: 'no-referrer-when-downgrade',
    sameOrigin: fullSourceReferrer,
    crossOrigin: fullSourceReferrer,
    downgrade: undefined,
  },
  {
    name: 'origin',
    policy: 'origin',
    sameOrigin: sourceOriginReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: sourceOriginReferrer,
  },
  {
    name: 'origin-when-cross-origin',
    policy: 'origin-when-cross-origin',
    sameOrigin: fullSourceReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: sourceOriginReferrer,
  },
  {
    name: 'same-origin',
    policy: 'same-origin',
    sameOrigin: fullSourceReferrer,
    crossOrigin: undefined,
    downgrade: undefined,
  },
  {
    name: 'strict-origin',
    policy: 'strict-origin',
    sameOrigin: sourceOriginReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: undefined,
  },
  {
    name: 'strict-origin-when-cross-origin',
    policy: 'strict-origin-when-cross-origin',
    sameOrigin: fullSourceReferrer,
    crossOrigin: sourceOriginReferrer,
    downgrade: undefined,
  },
  {
    name: 'unsafe-url',
    policy: 'unsafe-url',
    sameOrigin: fullSourceReferrer,
    crossOrigin: fullSourceReferrer,
    downgrade: fullSourceReferrer,
  },
];
const referrerPolicyCases = referrerPolicyMatrix.flatMap((row) => [
  {
    name: `${row.name} / same origin`,
    policy: row.policy,
    targetUrl: 'https://reader.example/image.jpg',
    expected: row.sameOrigin,
  },
  {
    name: `${row.name} / cross origin`,
    policy: row.policy,
    targetUrl: 'https://cdn.example/image.jpg',
    expected: row.crossOrigin,
  },
  {
    name: `${row.name} / HTTPS downgrade`,
    policy: row.policy,
    targetUrl: 'http://cdn.example/image.jpg',
    expected: row.downgrade,
  },
]);

describe('ImageDownloader', () => {
  it('downloads original bytes with the source page origin for an arbitrary cross-origin image', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const response = new Response(jpegBytes, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://cdn.example/final.jpg',
    });
    const fetchImage = vi.fn(async () => response);
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/source.jpg',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }, documentSource(
      'https://reader.example/chapter/1?mode=web#page-2',
    ))).resolves.toEqual({
      base64: '/9j/4AAQ',
      contentType: 'image/jpeg',
      sourceUrl: 'https://cdn.example/final.jpg',
    });

    expect(headerOverride.requests).toEqual([{
      url: 'https://cdn.example/source.jpg',
      headers: [{
        name: 'Referer',
        value: 'https://reader.example/',
      }],
    }]);
    expect(fetchImage).toHaveBeenCalledWith('https://cdn.example/source.jpg', {
      method: 'GET',
      credentials: 'include',
      cache: 'default',
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    });
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(1);
  });

  it.each(referrerPolicyCases)('honors $name', async ({ targetUrl, policy, expected }) => {
    await expect(observeInstalledReferer({
      targetUrl,
      referrerPolicy: policy,
    })).resolves.toBe(expected);
  });

  it('reduces an overlong full referrer to its origin', async () => {
    await expect(observeInstalledReferer({
      targetUrl: 'https://cdn.example/image.jpg',
      referrerPolicy: 'unsafe-url',
      source: documentSource(
        `https://reader.example/chapter?payload=${'x'.repeat(4_100)}`,
      ),
    })).resolves.toBe('https://reader.example/');
  });

  it('uses the normalized trusted document URL', async () => {
    await expect(observeInstalledReferer({
      targetUrl: 'https://cdn.example/image.jpg',
      source: documentSource('https://fallback.example/reader#page'),
    })).resolves.toBe('https://fallback.example/');
  });

  it('honors a tracked navigation Referrer-Policy header when the page has no DOM override', async () => {
    const observer = createReferrerPolicyObserverHarness();
    const headerOverride = createHeaderOverrideHarness();
    const downloader = createImageDownloader({
      referrerPolicies: observer.capability,
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    observer.emit({
      document: {
        documentId: 'document-1',
        tabId: 7,
        frameId: 0,
        url: 'https://reader.example/chapter/1?mode=web',
      },
      policy: 'origin, unsafe-url',
    });

    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource(
      'https://reader.example/chapter/1?mode=web#page-2',
      {
      documentId: 'document-1',
      },
    ));
    expect(getRequestedReferer(headerOverride)).toBe(
      'https://reader.example/chapter/1?mode=web',
    );

    const requestCount = headerOverride.requests.length;
    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
      referrerPolicy: 'no-referrer',
    }, documentSource(
      'https://reader.example/chapter/1?mode=web#page-2',
      { documentId: 'document-1' },
    ));
    expect(headerOverride.requests).toHaveLength(requestCount);
  });

  it('persists tracked document policies through the injected session storage capability', async () => {
    const observer = createReferrerPolicyObserverHarness();
    const read = vi.fn(async (keys: readonly string[]) => (
      Object.fromEntries(keys.map((key) => [key, undefined]))
    ));
    const write = vi.fn(async (_values: Readonly<Record<string, JsonValue>>) => {});
    createImageDownloader({
      referrerPolicies: observer.capability,
      sessionStorage: {
        read,
        write,
        remove: vi.fn(async () => {}),
      },
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledWith([
        'mangaTranslate.documentReferrerPolicies',
      ]);
    });
    observer.emit({
      document: {
        documentId: 'document-1',
        tabId: 7,
        frameId: 0,
        url: 'https://reader.example/chapter/1',
      },
      policy: 'origin',
    });

    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith({
        'mangaTranslate.documentReferrerPolicies': expect.any(Object),
      });
    });
  });

  it('does not reuse a tracked policy after the same frame navigates to a different document URL', async () => {
    const observer = createReferrerPolicyObserverHarness();
    const headerOverride = createHeaderOverrideHarness();
    const downloader = createImageDownloader({
      referrerPolicies: observer.capability,
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    observer.emit({
      document: {
        documentId: 'old-document',
        tabId: 7,
        frameId: 0,
        url: 'https://reader.example/chapter/old',
      },
      policy: 'unsafe-url',
    });

    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource(
      'https://reader.example/chapter/new?secret=value#page',
      { documentId: 'new-document' },
    ));

    expect(getRequestedReferer(headerOverride)).toBe('https://reader.example/');
  });

  it('downloads without a Referer rule when no trusted page URL exists', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource())).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });

    expect(headerOverride.requests).toHaveLength(0);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('does not issue a plain request when the temporary rule cannot be installed', async () => {
    const headerOverride = createHeaderOverrideHarness();
    headerOverride.rejectNextAcquire();
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource(
      'https://reader.example/chapter',
    ))).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'browser-rejected',
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(headerOverride.requests).toHaveLength(0);
    expect(headerOverride.releases).toHaveLength(0);
  });

  it('reports revoked target access as a structured operation failure', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const permissions: ExtensionPermissions = {
      async check(requirements) {
        return {
          status: 'not-granted',
          missing: requirements,
        };
      },
      async request() {
        throw new Error('image download must not prompt for host access');
      },
      onChanged() {
        return () => undefined;
      },
    };
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      permissions,
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/private/image.jpg?token=secret',
    }, documentSource(
      'https://reader.example/chapter/private?session=secret',
    ))).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'browser-rejected',
      retryable: false,
      diagnostic: {
        missingPermission: 'target-origin',
      },
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(headerOverride.requests).toHaveLength(0);
  });

  it('does not report success while a temporary header override remains active', async () => {
    const headerOverride = createHeaderOverrideHarness();
    headerOverride.rejectReleaseAttempts(2);
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource(
      'https://reader.example/chapter',
    ))).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'release',
      code: 'cleanup-failed',
      retryable: true,
      diagnostic: {
        errorName: 'Error',
      },
    });
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(2);
  });

  it('retries a retryable cleanup failure before reporting success', async () => {
    const headerOverride = createHeaderOverrideHarness();
    headerOverride.rejectNextRelease();
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, documentSource(
      'https://reader.example/chapter',
    ))).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(2);
  });

  it('does not try another candidate after header override cleanup fails', async () => {
    const headerOverride = createHeaderOverrideHarness();
    headerOverride.rejectReleaseAttempts(2);
    const fetchImage = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(createJpegResponse());
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://pbs.twimg.com/media/example?format=jpg&name=large',
    }, documentSource(
      'https://reader.example/chapter',
    ))).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      operation: 'release',
      code: 'cleanup-failed',
    });
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(2);
  });

  it('propagates structured acquisition failures without issuing an unprotected request', async () => {
    const headerOverride = createHeaderOverrideHarness();
    headerOverride.rejectNextAcquire(new Error(
      'Failed https://cdn.example/private/image.jpg?token=secret',
    ));
    const fetchImage = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    const result = downloader.download({
      imageUrl: 'https://cdn.example/private/image.jpg?token=secret',
    }, documentSource(
      'https://reader.example/chapter/private?session=secret',
    ));
    await expect(result).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'browser-rejected',
      retryable: false,
      diagnostic: {
        errorName: 'Error',
      },
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(headerOverride.releases).toHaveLength(0);
  });

  it('releases the temporary header override after an HTTP error', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => new Response('forbidden', { status: 403 })),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/private.jpg',
    }, documentSource(
      'https://reader.example/chapter',
    ))).rejects.toThrow('HTTP 403');
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('redacts URLs embedded in external exception text', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage: vi.fn(async () => {
        throw new Error(
          'Failed https://cdn.example/private/image.jpg?token=secret from https://reader.example/private/path',
        );
      }),
    });

    const result = downloader.download({
      imageUrl: 'https://cdn.example/private/image.jpg?token=secret',
    }, documentSource(
      'https://reader.example/private/path?session=secret',
    ));
    await expect(result).rejects.toThrow('host=cdn.example');
    await expect(result).rejects.not.toThrow('token=secret');
    await expect(result).rejects.not.toThrow('/private/path');
    await expect(result).rejects.toThrow('[URL_REDACTED]');
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('rejects successful anti-hotlink HTML and unknown payloads', async () => {
    const responses = [
      new Response('<html>blocked</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ];
    const downloader = createImageDownloader({
      fetchImage: vi.fn(async () => responses.shift() as Response),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/blocked.jpg',
    }, documentSource())).rejects.toThrow('服务器返回了 HTML，未返回原始图片');
    await expect(downloader.download({
      imageUrl: 'https://cdn.example/unknown.jpg',
    }, documentSource())).rejects.toThrow('响应不是支持的图片格式（application/octet-stream）');
  });

  it('rejects an empty successful response', async () => {
    const downloader = createImageDownloader({
      fetchImage: vi.fn(async () => new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/empty.png',
    }, documentSource())).rejects.toThrow('返回空文件');
  });

  it('tries the X original-size candidate before falling back to the requested URL', async () => {
    const fetchImage = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(createJpegResponse());
    const downloader = createImageDownloader({
      fetchImage,
    });
    const requestedUrl = 'https://pbs.twimg.com/media/example?format=jpg&name=large';

    await expect(downloader.download({
      imageUrl: requestedUrl,
    }, documentSource())).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([
      'https://pbs.twimg.com/media/example?format=jpg&name=orig',
      requestedUrl,
    ]);
  });

  it('allows concurrent downloads with independently released header leases', async () => {
    let resolveFirstResponse: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const headerOverride = createHeaderOverrideHarness();
    const firstUrl = 'https://first-cdn.example/image.jpg';
    const secondUrl = 'https://second-cdn.example/image.jpg';
    const fetchImage = vi.fn(async (url: string | URL | Request) => (
      url.toString() === firstUrl ? firstResponse : createJpegResponse()
    ));
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage,
    });

    const first = downloader.download({
      imageUrl: firstUrl,
    }, documentSource('https://first-reader.example/chapter'));
    const second = downloader.download({
      imageUrl: secondUrl,
    }, documentSource(
      'https://second-reader.example/chapter',
      { documentId: 'document-8', tabId: 8 },
    ));
    await vi.waitFor(() => {
      expect(fetchImage).toHaveBeenCalledTimes(2);
    });
    expect(headerOverride.requests).toEqual(expect.arrayContaining([
      {
        url: firstUrl,
        headers: [{
          name: 'Referer',
          value: 'https://first-reader.example/',
        }],
      },
      {
        url: secondUrl,
        headers: [{
          name: 'Referer',
          value: 'https://second-reader.example/',
        }],
      },
    ]));
    const firstLeaseIndex = headerOverride.requests.findIndex(
      (request) => request.url === firstUrl,
    );
    const secondLeaseIndex = headerOverride.requests.findIndex(
      (request) => request.url === secondUrl,
    );
    await expect(second).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(headerOverride.releases[firstLeaseIndex]).not.toHaveBeenCalled();
    expect(headerOverride.releases[secondLeaseIndex]).toHaveBeenCalledTimes(1);

    resolveFirstResponse?.(createJpegResponse());
    await expect(first).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([firstUrl, secondUrl]),
    );
    expect(headerOverride.releases[firstLeaseIndex]).toHaveBeenCalledTimes(1);
    expect(headerOverride.releases[secondLeaseIndex]).toHaveBeenCalledTimes(1);
  });

  it('aborts timed-out downloads and releases their temporary header override', async () => {
    const headerOverride = createHeaderOverrideHarness();
    const fetchImage = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    }));
    const downloader = createImageDownloader({
      requestHeaderOverride: headerOverride.capability,
      fetchImage: fetchImage as unknown as typeof fetch,
      timeoutMs: 5,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/slow.jpg',
    }, documentSource(
      'https://reader.example/chapter',
    ))).rejects.toThrow('请求超时（5ms）');
    expect(headerOverride.releases[0]).toHaveBeenCalledTimes(1);
  });

  it.each([
    'data:image/png;base64,aW1hZ2U=',
    'file:///tmp/image.png',
    'not a URL',
  ])('rejects unsupported image URL %s before fetching', async (imageUrl) => {
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      fetchImage,
    });

    await expect(downloader.download(
      { imageUrl },
      documentSource(),
    )).rejects.toThrow(/图片地址/u);
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
