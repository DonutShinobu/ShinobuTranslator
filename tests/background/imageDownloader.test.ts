import { describe, expect, it, vi } from 'vitest';
import { createImageDownloader } from '../../src/background/images/imageDownloader';
import type {
  ChromeDnrRuleUpdate,
  ChromeWebRequestHeadersDetails,
} from '../../src/shared/chrome';

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

type RuleUpdate = ChromeDnrRuleUpdate;

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

function getInstalledReferer(updateSessionRules: ReturnType<typeof vi.fn>): string | undefined {
  const install = updateSessionRules.mock.calls
    .map(([update]) => update as RuleUpdate)
    .find((update) => update.addRules.length > 0);
  const rule = install?.addRules[0] as {
    action?: {
      requestHeaders?: Array<{ value?: string }>;
    };
  } | undefined;
  return rule?.action?.requestHeaders?.[0]?.value;
}

async function observeInstalledReferer(options: {
  targetUrl: string;
  referrerPolicy?: ReferrerPolicy;
  sender?: {
    documentUrl?: string;
    tab?: { id?: number; url?: string };
  };
}): Promise<string | undefined> {
  const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
  const downloader = createImageDownloader({
    chromeApi: {
      runtime: { id: 'shinobu-extension-id' },
      declarativeNetRequest: {
        updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
        updateSessionRules,
      },
    },
    fetchImage: vi.fn(async () => createJpegResponse()),
  });
  await downloader.download({
    imageUrl: options.targetUrl,
    referrerPolicy: options.referrerPolicy,
  }, options.sender ?? {
    documentUrl: 'https://user:password@reader.example/chapter/1?mode=web#page-2',
  });
  return getInstalledReferer(updateSessionRules);
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
    const updateDynamicRules = vi.fn(async () => {});
    const updateSessionRules = vi.fn(async () => {});
    const response = new Response(jpegBytes, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://cdn.example/final.jpg',
    });
    const fetchImage = vi.fn(async () => response);
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules,
          updateSessionRules,
        },
      },
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/source.jpg',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }, {
      documentUrl: 'https://reader.example/chapter/1?mode=web#page-2',
      tab: { id: 7, url: 'https://reader.example/chapter/1?mode=web#page-2' },
    })).resolves.toEqual({
      base64: '/9j/4AAQ',
      contentType: 'image/jpeg',
      sourceUrl: 'https://cdn.example/final.jpg',
    });

    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1],
      addRules: [],
    });
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [2],
      addRules: [{
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: 'https://reader.example/',
          }],
        },
        condition: {
          initiatorDomains: ['shinobu-extension-id'],
          requestDomains: ['cdn.example'],
          tabIds: [-1],
          requestMethods: ['get'],
          resourceTypes: ['xmlhttprequest'],
        },
      }],
    });
    expect(fetchImage).toHaveBeenCalledWith('https://cdn.example/source.jpg', {
      method: 'GET',
      credentials: 'include',
      cache: 'default',
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    });
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
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
      sender: {
        documentUrl: `https://reader.example/chapter?payload=${'x'.repeat(4_100)}`,
      },
    })).resolves.toBe('https://reader.example/');
  });

  it('uses the trusted tab URL when documentUrl is unavailable', async () => {
    await expect(observeInstalledReferer({
      targetUrl: 'https://cdn.example/image.jpg',
      sender: {
        documentUrl: 'about:blank',
        tab: { id: 7, url: 'https://fallback.example/reader#page' },
      },
    })).resolves.toBe('https://fallback.example/');
  });

  it('honors a tracked navigation Referrer-Policy header when the page has no DOM override', async () => {
    let headersListener: ((details: ChromeWebRequestHeadersDetails) => void) | undefined;
    const addListener = vi.fn((
      listener: (details: ChromeWebRequestHeadersDetails) => void,
    ) => {
      headersListener = listener;
    });
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
        webRequest: {
          onHeadersReceived: { addListener },
        },
      },
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    expect(addListener).toHaveBeenCalledWith(
      expect.any(Function),
      {
        urls: ['<all_urls>'],
        types: ['main_frame', 'sub_frame'],
      },
      ['responseHeaders', 'extraHeaders'],
    );
    headersListener?.({
      documentId: 'document-1',
      tabId: 7,
      frameId: 0,
      url: 'https://reader.example/chapter/1?mode=web',
      responseHeaders: [{
        name: 'Referrer-Policy',
        value: 'origin, unsafe-url',
      }],
    });

    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, {
      documentId: 'document-1',
      documentUrl: 'https://reader.example/chapter/1?mode=web#page-2',
      frameId: 0,
      tab: { id: 7 },
    });
    expect(getInstalledReferer(updateSessionRules)).toBe(
      'https://reader.example/chapter/1?mode=web',
    );

    updateSessionRules.mockClear();
    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
      referrerPolicy: 'no-referrer',
    }, {
      documentId: 'document-1',
      documentUrl: 'https://reader.example/chapter/1?mode=web#page-2',
      frameId: 0,
      tab: { id: 7 },
    });
    expect(updateSessionRules.mock.calls
      .map(([update]) => update as RuleUpdate)
      .filter((update) => update.addRules.length > 0)).toHaveLength(0);
  });

  it('does not reuse a tracked policy after the same frame navigates to a different document URL', async () => {
    let headersListener: ((details: ChromeWebRequestHeadersDetails) => void) | undefined;
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
        webRequest: {
          onHeadersReceived: {
            addListener(listener) {
              headersListener = listener;
            },
          },
        },
      },
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    headersListener?.({
      tabId: 7,
      frameId: 0,
      url: 'https://reader.example/chapter/old',
      responseHeaders: [{
        name: 'Referrer-Policy',
        value: 'unsafe-url',
      }],
    });

    await downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, {
      documentId: 'new-document',
      documentUrl: 'https://reader.example/chapter/new?secret=value#page',
      frameId: 0,
      tab: { id: 7 },
    });

    expect(getInstalledReferer(updateSessionRules)).toBe('https://reader.example/');
  });

  it('downloads without a Referer rule when no trusted page URL exists', async () => {
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, {})).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });

    expect(updateSessionRules.mock.calls
      .map(([update]) => update as RuleUpdate)
      .filter((update) => update.addRules.length > 0)).toHaveLength(0);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain request when the temporary rule cannot be installed', async () => {
    const updateSessionRules = vi.fn(async (update: RuleUpdate) => {
      if (update.addRules.length > 0) throw new Error('DNR permission unavailable');
    });
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, {
      documentUrl: 'https://reader.example/chapter',
    })).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
  });

  it('does not report success while a temporary Referer rule remains active', async () => {
    let sessionUpdateCount = 0;
    const updateSessionRules = vi.fn(async (update: RuleUpdate) => {
      sessionUpdateCount += 1;
      if (sessionUpdateCount >= 3 && update.addRules.length === 0) {
        throw new Error('session cleanup failed');
      }
    });
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: vi.fn(async () => createJpegResponse()),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/image.jpg',
    }, {
      documentUrl: 'https://reader.example/chapter',
    })).rejects.toThrow('临时 Referer 规则清理失败');
  });

  it('reports sanitized acquisition diagnostics when both DNR and the request fail', async () => {
    const updateSessionRules = vi.fn(async (update: RuleUpdate) => {
      if (update.addRules.length > 0) throw new Error('DNR permission unavailable');
    });
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: vi.fn(async () => new Response('forbidden', { status: 403 })),
    });

    const result = downloader.download({
      imageUrl: 'https://cdn.example/private/image.jpg?token=secret',
    }, {
      documentUrl: 'https://reader.example/chapter/private?session=secret',
    });
    await expect(result).rejects.toThrow(
      '无法取得原始图片字节: 候选 1/1, host=cdn.example, referer=none, HTTP 403',
    );
    await expect(result).rejects.not.toThrow('token=secret');
    await expect(result).rejects.not.toThrow('session=secret');
    await expect(result).rejects.toThrow('DNR=DNR permission unavailable');
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
  });

  it('removes the temporary rule after an HTTP error', async () => {
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: vi.fn(async () => new Response('forbidden', { status: 403 })),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/private.jpg',
    }, {
      documentUrl: 'https://reader.example/chapter',
    })).rejects.toThrow('HTTP 403');
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
  });

  it('redacts URLs embedded in external exception text', async () => {
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: vi.fn(async () => {
        throw new Error(
          'Failed https://cdn.example/private/image.jpg?token=secret from https://reader.example/private/path',
        );
      }),
    });

    const result = downloader.download({
      imageUrl: 'https://cdn.example/private/image.jpg?token=secret',
    }, {
      documentUrl: 'https://reader.example/private/path?session=secret',
    });
    await expect(result).rejects.toThrow('host=cdn.example');
    await expect(result).rejects.not.toThrow('token=secret');
    await expect(result).rejects.not.toThrow('/private/path');
    await expect(result).rejects.toThrow('[URL_REDACTED]');
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
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
      chromeApi: null,
      fetchImage: vi.fn(async () => responses.shift() as Response),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/blocked.jpg',
    }, {})).rejects.toThrow('服务器返回了 HTML，未返回原始图片');
    await expect(downloader.download({
      imageUrl: 'https://cdn.example/unknown.jpg',
    }, {})).rejects.toThrow('响应不是支持的图片格式（application/octet-stream）');
  });

  it('rejects an empty successful response', async () => {
    const downloader = createImageDownloader({
      chromeApi: null,
      fetchImage: vi.fn(async () => new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })),
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/empty.png',
    }, {})).rejects.toThrow('返回空文件');
  });

  it('tries the X original-size candidate before falling back to the requested URL', async () => {
    const fetchImage = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(createJpegResponse());
    const downloader = createImageDownloader({
      chromeApi: null,
      fetchImage,
    });
    const requestedUrl = 'https://pbs.twimg.com/media/example?format=jpg&name=large';

    await expect(downloader.download({
      imageUrl: requestedUrl,
    }, {})).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([
      'https://pbs.twimg.com/media/example?format=jpg&name=orig',
      requestedUrl,
    ]);
  });

  it('serializes concurrent downloads so temporary request contexts cannot overlap', async () => {
    let resolveFirstResponse: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const sessionEvents: string[] = [];
    const updateSessionRules = vi.fn(async (update: RuleUpdate) => {
      const referer = (update.addRules[0] as {
        action?: { requestHeaders?: Array<{ value?: string }> };
      } | undefined)?.action?.requestHeaders?.[0]?.value;
      sessionEvents.push(referer ? `install:${referer}` : 'remove');
    });
    const fetchImage = vi.fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementationOnce(async () => createJpegResponse());
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage,
    });

    const first = downloader.download({
      imageUrl: 'https://first-cdn.example/image.jpg',
    }, {
      documentUrl: 'https://first-reader.example/chapter',
    });
    const second = downloader.download({
      imageUrl: 'https://second-cdn.example/image.jpg',
    }, {
      documentUrl: 'https://second-reader.example/chapter',
    });
    await vi.waitFor(() => {
      expect(fetchImage).toHaveBeenCalledTimes(1);
    });
    expect(sessionEvents).toEqual([
      'remove',
      'install:https://first-reader.example/',
    ]);

    resolveFirstResponse?.(createJpegResponse());
    await expect(first).resolves.toMatchObject({ contentType: 'image/jpeg' });
    await expect(second).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(fetchImage.mock.calls.map(([url]) => url)).toEqual([
      'https://first-cdn.example/image.jpg',
      'https://second-cdn.example/image.jpg',
    ]);
    expect(sessionEvents).toEqual([
      'remove',
      'install:https://first-reader.example/',
      'remove',
      'install:https://second-reader.example/',
      'remove',
    ]);
  });

  it('aborts timed-out downloads and removes their temporary rule', async () => {
    const updateSessionRules = vi.fn(async (_update: RuleUpdate) => {});
    const fetchImage = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    }));
    const downloader = createImageDownloader({
      chromeApi: {
        runtime: { id: 'shinobu-extension-id' },
        declarativeNetRequest: {
          updateDynamicRules: vi.fn(async (_update: RuleUpdate) => {}),
          updateSessionRules,
        },
      },
      fetchImage: fetchImage as unknown as typeof fetch,
      timeoutMs: 5,
    });

    await expect(downloader.download({
      imageUrl: 'https://cdn.example/slow.jpg',
    }, {
      documentUrl: 'https://reader.example/chapter',
    })).rejects.toThrow('请求超时（5ms）');
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [2],
      addRules: [],
    });
  });

  it.each([
    'data:image/png;base64,aW1hZ2U=',
    'file:///tmp/image.png',
    'not a URL',
  ])('rejects unsupported image URL %s before fetching', async (imageUrl) => {
    const fetchImage = vi.fn(async () => createJpegResponse());
    const downloader = createImageDownloader({
      chromeApi: null,
      fetchImage,
    });

    await expect(downloader.download({ imageUrl }, {})).rejects.toThrow(/图片地址/u);
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
