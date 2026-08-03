import { describe, expect, it, vi } from 'vitest';
import {
  publishChromeWebStoreUpdate,
  SHINOBU_CHROME_EXTENSION_ID,
} from '../../scripts/publish-chrome-web-store.mjs';

type JsonResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

function response({ status = 200, headers = {}, body = {} }: JsonResponse = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function revision(state: string, version: string) {
  return {
    state,
    distributionChannels: [{ deployPercentage: 100, crxVersion: version }],
  };
}

function createOptions(fetchImpl: typeof fetch) {
  return {
    accessToken: 'short-lived-token',
    publisherId: 'publisher-123',
    extensionId: SHINOBU_CHROME_EXTENSION_ID,
    expectedVersion: '0.9.0',
    packageBytes: new Uint8Array([1, 2, 3]),
    fetchImpl,
    sleep: vi.fn(async () => undefined),
    retryBaseDelayMs: 1,
    uploadPollIntervalMs: 1,
  };
}

describe('Chrome Web Store publishing', () => {
  it('uploads the package and requests immediate full publication after review', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        body: { publishedItemRevisionStatus: revision('PUBLISHED', '0.8.1') },
      }))
      .mockResolvedValueOnce(response({
        body: { uploadState: 'SUCCEEDED', crxVersion: '0.9.0' },
      }))
      .mockResolvedValueOnce(response({ body: { state: 'PENDING_REVIEW' } }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).resolves.toEqual({
      extensionId: SHINOBU_CHROME_EXTENSION_ID,
      version: '0.9.0',
      outcome: 'submitted',
      state: 'PENDING_REVIEW',
    });

    expect(fetchImpl.mock.calls[1][0]).toContain('/upload/v2/publishers/publisher-123/items/');
    const publishRequest = fetchImpl.mock.calls[2][1];
    expect(JSON.parse(String(publishRequest?.body))).toEqual({
      publishType: 'DEFAULT_PUBLISH',
      deployInfos: [{ deployPercentage: 100 }],
      skipReview: false,
      blockOnWarnings: true,
    });
  });

  it('polls an asynchronous upload before publishing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ body: { uploadState: 'IN_PROGRESS' } }))
      .mockResolvedValueOnce(response({ body: { lastAsyncUploadState: 'IN_PROGRESS' } }))
      .mockResolvedValueOnce(response({ body: { lastAsyncUploadState: 'SUCCEEDED' } }))
      .mockResolvedValueOnce(response({ body: { state: 'PUBLISHED' } }));
    const options = createOptions(fetchImpl);

    await expect(publishChromeWebStoreUpdate(options)).resolves.toMatchObject({
      outcome: 'submitted',
      state: 'PUBLISHED',
    });
    expect(options.sleep).toHaveBeenCalledTimes(2);
  });

  it('rejects an uploaded package whose manifest version differs', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        body: { uploadState: 'SUCCEEDED', crxVersion: '0.8.1' },
      }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).rejects.toThrow(
      /accepted version 0\.8\.1, expected 0\.9\.0/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces publish validation warnings as a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        body: { uploadState: 'SUCCEEDED', crxVersion: '0.9.0' },
      }))
      .mockResolvedValueOnce(response({
        status: 400,
        body: { error: { message: 'Package has blocking warnings' } },
      }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).rejects.toThrow(
      /HTTP 400.*blocking warnings/,
    );
  });

  it('does not retry authentication failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      status: 401,
      body: { error: { message: 'Invalid credentials' } },
    }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).rejects.toThrow(/HTTP 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries rate-limited requests using Retry-After', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        body: { uploadState: 'SUCCEEDED', crxVersion: '0.9.0' },
      }))
      .mockResolvedValueOnce(response({ body: { state: 'PENDING_REVIEW' } }));
    const options = createOptions(fetchImpl);

    await publishChromeWebStoreUpdate(options);
    expect(options.sleep).toHaveBeenCalledWith(2000);
  });

  it('treats the target version already under review as an idempotent success', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      body: { submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.9.0') },
    }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).resolves.toMatchObject({
      outcome: 'already-submitted',
      state: 'PENDING_REVIEW',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats the target version already published as an idempotent success', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      body: { publishedItemRevisionStatus: revision('PUBLISHED', '0.9.0') },
    }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).resolves.toMatchObject({
      outcome: 'already-published',
      state: 'PUBLISHED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to replace a different version already under review', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      body: { submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.8.2') },
    }));

    await expect(publishChromeWebStoreUpdate(createOptions(fetchImpl))).rejects.toThrow(
      /already has 0\.8\.2 in state PENDING_REVIEW/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
