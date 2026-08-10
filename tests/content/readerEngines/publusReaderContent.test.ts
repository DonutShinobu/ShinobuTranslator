import { describe, expect, it, vi } from 'vitest';
import {
  createPublusReaderContentClient,
  parsePublusV1Manifest,
  PublusReaderInvalidResponseError,
  PublusReaderUnsupportedError,
  type PublusObservedSession,
  type PublusReaderResourceFetcher,
} from '../../../apps/extension/src/content/readerEngines/publusReaderContent';
import type { PublusV1Keys } from '../../../apps/extension/src/content/readerEngines/publusReaderV1';

const viewerUrl = 'https://reader.example/viewer/viewer.html?cid=work-token&cty=1';
const contentBaseUrl = 'https://cdn.example/contents/work/';

function fixedLayoutPack(
  pageCount = 2,
  imageTypes: readonly string[] = [],
): Record<string, unknown> {
  const contents = Array.from({ length: pageCount }, (_, pageIndex) => ({
    file: `OEBPS/text/p-${String(pageIndex + 1).padStart(4, '0')}.xhtml`,
    index: pageIndex + 1,
    type: imageTypes[pageIndex] ?? 'jpeg',
  }));
  return {
    configuration: {
      contents,
      'page-progression-direction': 'rtl',
    },
    ...Object.fromEntries(contents.map((content) => [content.file, {
      FileLinkInfo: {
        PageLinkInfoList: [{
          Page: {
            No: 0,
            Size: { Width: 1440, Height: 2048 },
          },
        }],
      },
    }])),
  };
}

function observedSession(): PublusObservedSession {
  return {
    viewerUrl,
    contentCheckUrl: 'https://reader.example/trial-page/c?cid=work-token&BID=browser-NFBR',
    configurationUrl: `${contentBaseUrl}configuration_pack.json`,
    protocolMajor: 2,
  };
}

const syntheticKeys = [
  Uint8Array.from({ length: 32 }, (_, index) => index),
  Uint8Array.from({ length: 32 }, (_, index) => index + 32),
  Uint8Array.from({ length: 32 }, (_, index) => index + 64),
] as const satisfies PublusV1Keys;

function packedConfiguration(file = 'OEBPS/text/synthetic.xhtml'): Record<string, unknown> {
  return {
    configuration: {
      'file-name-version': '1.0',
      contents: [{ file, index: 1, type: 'jpeg' }],
      'page-progression-direction': 'ltr',
    },
    [file]: {
      FileLinkInfo: {
        PageLinkInfoList: [{
          Page: {
            No: 0,
            Size: { Width: 70, Height: 66 },
            BlockWidth: 16,
            BlockHeight: 16,
            DummyWidth: 0,
            DummyHeight: 0,
            NS: 123456789,
            PS: 987654321,
            RS: 246813579,
          },
        }],
      },
    },
  };
}

describe('PUBLUS Reader content protocol', () => {
  it('discovers a plaintext fixed-layout directory and prepares an unseen page', async () => {
    const pack = fixedLayoutPack(2, ['jpeg', 'png']);
    const fetchResource: PublusReaderResourceFetcher = vi.fn(async (request) => {
      if (request.url.includes('/trial-page/c?')) {
        return {
          text: JSON.stringify({
            status: 200,
            url: contentBaseUrl,
            lp: 2,
            cty: 1,
            auth_info: {
              Policy: 'short-lived-policy',
              Signature: 'short-lived-signature',
              'Key-Pair-Id': 'short-lived-key-id',
              unexpected: 'must-not-propagate',
            },
          }),
          contentType: 'application/json',
          sourceUrl: request.url,
        };
      }
      return {
        text: JSON.stringify(pack),
        contentType: 'application/json',
        sourceUrl: request.url,
      };
    });
    const prepared = new File(['page'], 'prepared.png', { type: 'image/png' });
    const downloadImage = vi.fn(async (source: { url: string; allowedBaseUrl?: string }) => {
      expect(source.allowedBaseUrl).toBe(contentBaseUrl);
      expect(source.url).toBe(
        `${contentBaseUrl}OEBPS/text/p-0002.xhtml/0.png`
          + '?Policy=short-lived-policy&Signature=short-lived-signature&Key-Pair-Id=short-lived-key-id',
      );
      return { file: prepared, blob: prepared };
    });
    const client = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource,
      downloadImage,
      document: {} as Document,
    });

    await expect(client.read()).resolves.toMatchObject({
      profile: 'v2-plain',
      pageCount: 2,
      direction: 'rtl',
    });
    await expect(client.acquirePublusPageFile(1, new AbortController().signal)).resolves.toBe(prepared);
  });

  it('builds a packed 1.x manifest from the authoritative directory', () => {
    const manifest = parsePublusV1Manifest(
      packedConfiguration(),
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '?Policy=temporary' },
    );

    expect(manifest).toMatchObject({ profile: 'v1-packed', pageCount: 1, direction: 'ltr' });
    expect(manifest.pages[0]).toMatchObject({
      pageIndex: 0,
      width: 70,
      height: 66,
      request: {
        url: `${contentBaseUrl}OEBPS/text/synthetic.xhtml/108b185248f6bd3598.jpeg`
          + '?Policy=temporary',
        allowedBaseUrl: contentBaseUrl,
      },
      restoration: { kind: 'publus-v1' },
    });
  });

  it('fails closed for unsafe, discontinuous, or unknown packed profiles', () => {
    expect(() => parsePublusV1Manifest(
      packedConfiguration('../outside.xhtml'),
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderInvalidResponseError);
    expect(() => parsePublusV1Manifest(
      packedConfiguration('OEBPS/%2e%2e/outside.xhtml'),
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderInvalidResponseError);

    const discontinuous = packedConfiguration();
    ((discontinuous.configuration as { contents: Array<{ index: number }> }).contents[0]!).index = 2;
    expect(() => parsePublusV1Manifest(
      discontinuous,
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderInvalidResponseError);

    const unknown = packedConfiguration();
    (unknown.configuration as Record<string, unknown>)['file-name-version'] = '1.1';
    expect(() => parsePublusV1Manifest(
      unknown,
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderUnsupportedError);

    const multiPage = packedConfiguration();
    const links = (((multiPage['OEBPS/text/synthetic.xhtml'] as Record<string, unknown>)
      .FileLinkInfo as Record<string, unknown>).PageLinkInfoList as unknown[]);
    links.push(structuredClone(links[0]));
    expect(() => parsePublusV1Manifest(
      multiPage,
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderUnsupportedError);

    const huge = packedConfiguration();
    const hugePage = (((((huge['OEBPS/text/synthetic.xhtml'] as Record<string, unknown>)
      .FileLinkInfo as Record<string, unknown>).PageLinkInfoList as Array<Record<string, unknown>>)[0]!)
      .Page as Record<string, unknown>);
    hugePage.Size = { Width: 20_000, Height: 20_000 };
    expect(() => parsePublusV1Manifest(
      huge,
      syntheticKeys,
      { contentBaseUrl, pageCount: 1, query: '' },
    )).toThrow(PublusReaderInvalidResponseError);

    expect(() => parsePublusV1Manifest(
      packedConfiguration(),
      syntheticKeys,
      { contentBaseUrl, pageCount: 2, query: '' },
    )).toThrow(PublusReaderInvalidResponseError);
  });

  it('refreshes permission and configuration once after an image request fails', async () => {
    const pack = fixedLayoutPack(1);
    const fetchResource: PublusReaderResourceFetcher = vi.fn(async (request) => ({
      text: request.url.includes('/trial-page/c?')
        ? JSON.stringify({ status: 200, url: contentBaseUrl, lp: 1, cty: 1 })
        : JSON.stringify(pack),
      contentType: 'application/json',
      sourceUrl: request.url,
    }));
    const prepared = new File(['page'], 'prepared.jpeg', { type: 'image/jpeg' });
    const downloadImage = vi.fn()
      .mockRejectedValueOnce(new Error('expired permission'))
      .mockResolvedValueOnce({ file: prepared, blob: prepared });
    const client = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource,
      downloadImage,
      document: {} as Document,
    });

    await expect(client.acquirePublusPageFile(0, new AbortController().signal)).resolves.toBe(prepared);
    expect(downloadImage).toHaveBeenCalledTimes(2);
    expect(fetchResource).toHaveBeenCalledTimes(4);
  });

  it('honors an already-aborted read signal', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    const client = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource: vi.fn(),
      downloadImage: vi.fn(),
      document: {} as Document,
    });

    await expect(client.read({ signal: controller.signal })).rejects.toBe(reason);
  });

  it('rejects invalid lp values and enforces the absolute 200-page limit', async () => {
    const invalidLp = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource: vi.fn(async (request) => ({
        text: JSON.stringify({ status: 200, url: contentBaseUrl, lp: -1, cty: 1 }),
        contentType: 'application/json',
        sourceUrl: request.url,
      })),
      downloadImage: vi.fn(),
      document: {} as Document,
    });
    await expect(invalidLp.read()).rejects.toBeInstanceOf(PublusReaderInvalidResponseError);

    const tooManyPages = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource: vi.fn(async (request) => ({
        text: request.url.includes('/trial-page/c?')
          ? JSON.stringify({ status: 200, url: contentBaseUrl, lp: 201, cty: 1 })
          : JSON.stringify(fixedLayoutPack(201)),
        contentType: 'application/json',
        sourceUrl: request.url,
      })),
      downloadImage: vi.fn(),
      document: {} as Document,
      pageLimit: 201,
    });
    await expect(tooManyPages.read()).rejects.toBeInstanceOf(PublusReaderUnsupportedError);
  });

  it('rejects malformed values in allowlisted authorization fields', async () => {
    const client = createPublusReaderContentClient({
      readObservedSession: observedSession,
      fetchResource: vi.fn(async (request) => ({
        text: JSON.stringify({
          status: 200,
          url: contentBaseUrl,
          lp: 1,
          cty: 1,
          auth_info: { Policy: ['not-a-scalar'] },
        }),
        contentType: 'application/json',
        sourceUrl: request.url,
      })),
      downloadImage: vi.fn(),
      document: {} as Document,
    });

    await expect(client.read()).rejects.toBeInstanceOf(PublusReaderInvalidResponseError);
  });
});
