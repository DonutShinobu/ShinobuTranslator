import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBinbImageRequest,
  acquireBinbPageFile,
  createBinbContextKey,
  createBinbDescramblePlan,
  createBinbContentClient,
  decodeBinbTable,
  generateBinbSharedKey,
  identifyBinbImageQuality,
  restoreBinbPageImage,
  type BinbResourceFetcher,
  type BinbServerType,
  type BinbViewMode,
  type BinbManifest,
} from '../../../apps/extension/src/content/readerEngines/binbContent';

const cid = 'chapter-1';
const randomBlock = 'ABCDEFGHIJKLMNOP';

function encodeTable(sharedKey: string, value: unknown): string {
  const plain = JSON.stringify(value);
  const seedSource = `${cid}:${sharedKey}`;
  let seed = [...seedSource].reduce(
    (sum, character, index) => sum + (character.charCodeAt(0) << (index % 16)),
    0,
  ) & 0x7fffffff;
  if (seed === 0) seed = 0x12345678;
  let encoded = '';
  for (const character of plain) {
    seed = (seed >>> 1) ^ (1210056708 & -(seed & 1));
    const offset = seed % 94;
    const code = ((character.charCodeAt(0) - 32 - offset) % 94 + 94) % 94 + 32;
    encoded += String.fromCharCode(code);
  }
  return encoded;
}

function ttx(src = 'pages/page-1.jpg'): string {
  return [
    '<t-document>',
    '<t-case type="portrait">',
    `<t-img id="P0000" src="${src}" orgwidth="1129" orgheight="1600" />`,
    '<t-img id="P0001" src="pages/page-2.jpg" orgwidth="1129" orgheight="1600" />',
    '</t-case>',
    '<t-case type="landscape">',
    `<t-img id="L0000" src="${src}" orgwidth="1129" orgheight="1600" />`,
    '<t-img id="L0001" src="pages/page-2.jpg" orgwidth="1129" orgheight="1600" />',
    '</t-case>',
    '</t-document>',
  ].join('');
}

function metadata(
  sharedKey: string,
  serverType: BinbServerType,
  viewMode: BinbViewMode,
  contentsServer: string,
) {
  return {
    result: 1,
    items: [{
      // Some shops expose a request CID that intentionally differs from the
      // canonical ContentID returned by the current signed metadata request.
      ContentID: 'store-content-id',
      ContentsServer: contentsServer,
      ServerType: serverType,
      ViewMode: viewMode,
      ContentDate: '20260809010203',
      p: 'request-token',
      stbl: encodeTable(sharedKey, [5, 4, 3]),
      ttbl: encodeTable(sharedKey, [45331, 26012]),
      ptbl: encodeTable(sharedKey, Array.from({ length: 8 }, () => '8-8-' + 'aa'.repeat(64))),
      ctbl: encodeTable(sharedKey, Array.from({ length: 8 }, () => '8-8-' + 'aa'.repeat(64))),
    }],
  };
}

function contentBody(serverType: BinbServerType): string {
  const value = JSON.stringify({
    SBCVersion: '1.0',
    result: 1,
    ImageClass: serverType === 2 ? 'default' : 'multiquality',
    ttx: ttx(),
  });
  return serverType === 1 ? `DataGet_Content(${value});` : value;
}

describe('BinB content protocol', () => {
  it('generates and decodes the official table key deterministically', () => {
    const sharedKey = generateBinbSharedKey(cid, () => randomBlock);

    expect(sharedKey).toBe('AFBfCPDeEhFxGnHpILJVKiLbMlNxOoP3');
    const encoded = encodeTable(sharedKey, ['alpha', 2, true]);
    expect(decodeBinbTable(cid, sharedKey, encoded)).toEqual(['alpha', 2, true]);
  });

  for (const serverType of [0, 1, 2] as const) {
    for (const viewMode of [1, 2, 3] as const) {
      it(`loads ServerType ${serverType} / ViewMode ${viewMode} and keeps physical pages unique`, async () => {
        const sharedKey = generateBinbSharedKey(cid, () => randomBlock);
        const contentsServer = `https://cdn.example/backend-${serverType}/book`;
        const requests: Parameters<BinbResourceFetcher>[0][] = [];
        const fetchResource: BinbResourceFetcher = vi.fn(async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            return {
              text: JSON.stringify(metadata(sharedKey, serverType, viewMode, contentsServer)),
              contentType: 'application/json',
              sourceUrl: request.url,
            };
          }
          return {
            text: contentBody(serverType),
            contentType: serverType === 1 ? 'text/javascript' : 'application/json',
            sourceUrl: request.url,
          };
        });
        const client = createBinbContentClient({
          cid,
          metadataUrl: 'https://reader.example/bib/bibGetCntntInfo?u0=1',
          readerUrl: 'https://reader.example/viewer/?cid=chapter-1&u3=shop-key',
          fetchResource,
          randomBlock: () => randomBlock,
          now: () => 123456789,
        });

        const manifest = await client.read();

        expect(manifest).toMatchObject({
          cid,
          serverType,
          viewMode,
          contentBaseUrl: `${contentsServer}/`,
          imageClass: 'multiquality',
          scrambleTables: {
            stbl: [5, 4, 3],
            ttbl: [45331, 26012],
          },
        });
        expect(manifest.pages).toEqual([
          expect.objectContaining({ pageIndex: 0, src: 'pages/page-1.jpg', width: 1129, height: 1600 }),
          expect.objectContaining({ pageIndex: 1, src: 'pages/page-2.jpg', width: 1129, height: 1600 }),
        ]);
        expect(requests[0].url).toContain('cid=chapter-1');
        expect(requests[0].url).toContain(`k=${encodeURIComponent(sharedKey)}`);
        expect(requests[0].url).toContain('u0=1');
        expect(requests[0].url).toContain('u3=shop-key');
        expect(requests[1].allowedBaseUrl).toBe(`${contentsServer}/`);

        const image = buildBinbImageRequest(manifest, manifest.pages[0], 'low');
        expect(image.allowedBaseUrl).toBe(`${contentsServer}/`);
        expect(identifyBinbImageQuality(manifest, image.url)).toBe('low');
        const highImage = buildBinbImageRequest(manifest, manifest.pages[0], 'high');
        expect(identifyBinbImageQuality(manifest, highImage.url)).toBe(
          serverType === 0 && viewMode !== 1 ? 'low' : 'high',
        );
        expect(identifyBinbImageQuality(manifest, 'https://evil.example/M_H.jpg')).toBeNull();
        if (serverType === 0) {
          const foreignContentImage = new URL(highImage.url);
          foreignContentImage.searchParams.set('cid', 'another-content');
          expect(identifyBinbImageQuality(manifest, foreignContentImage.href)).toBeNull();
        }
        if (serverType === 0) {
          expect(requests[1].url).toContain('/sbcGetCntnt.php?');
          expect(image.url).toContain('/sbcGetImg.php?');
          expect(image.url).toContain(`vm=${viewMode}`);
          expect(image.url).toContain('q=1');
        } else if (serverType === 1) {
          expect(requests[1].url).toContain('/content.js?');
          expect(image.url).toContain('/pages/page-1.jpg/M_L.jpg?');
        } else {
          expect(requests[1].url).toBe(`${contentsServer}/content`);
          expect(image.url).toContain('/img/pages/page-1.jpg?');
          expect(image.url).toContain('q=1');
        }
      });
    }
  }

  it('rejects insecure content servers and sources that escape the declared base path', async () => {
    const sharedKey = generateBinbSharedKey(cid, () => randomBlock);
    const insecure = createBinbContentClient({
      cid,
      metadataUrl: 'https://reader.example/bib/info',
      readerUrl: 'https://reader.example/viewer/?cid=chapter-1',
      randomBlock: () => randomBlock,
      fetchResource: async (request) => ({
        text: JSON.stringify(metadata(sharedKey, 2, 2, 'http://cdn.example/book')),
        contentType: 'application/json',
        sourceUrl: request.url,
      }),
    });
    await expect(insecure.read()).rejects.toThrow(/HTTPS/u);

    let requestCount = 0;
    const escaping = createBinbContentClient({
      cid,
      metadataUrl: 'https://reader.example/bib/info',
      readerUrl: 'https://reader.example/viewer/?cid=chapter-1',
      randomBlock: () => randomBlock,
      fetchResource: async (request) => ({
        text: requestCount++ === 0
          ? JSON.stringify(metadata(sharedKey, 2, 2, 'https://cdn.example/books/current'))
          : JSON.stringify({ result: 1, ttx: ttx('../../outside.jpg') }),
        contentType: 'application/json',
        sourceUrl: request.url,
      }),
    });
    const manifest = await escaping.read();
    expect(() => buildBinbImageRequest(manifest, manifest.pages[0], 'low'))
      .toThrow(/内容服务器路径/u);
  });
});

const scrambleAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const legacyAlphabet = 'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';

function fKey(sign: '-' | '+', swapFirstTiles = false): string {
  const positions = 'A'.repeat(16);
  const pieces = Array.from({ length: 64 }, (_, index) => index);
  if (swapFirstTiles) [pieces[0], pieces[1]] = [pieces[1], pieces[0]];
  return `=8-8${sign}4-${positions}${pieces.map((index) => scrambleAlphabet[index]).join('')}`;
}

function aKey(swapFirstTiles = false): string {
  const positions: Array<[number, number]> = [];
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 7; column += 1) positions.push([column * 2, row * 2]);
  }
  for (let column = 0; column < 7; column += 1) positions.push([column * 2, 14]);
  for (let row = 0; row < 7; row += 1) positions.push([14, row * 2]);
  positions.push([14, 14]);
  if (swapFirstTiles) [positions[0], positions[1]] = [positions[1], positions[0]];
  return `8-8-${positions.map(([x, y]) => `${legacyAlphabet[x]}${legacyAlphabet[y]}`).join('')}`;
}

describe('BinB page restoration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes the current F table, removes padding, and moves every source tile', () => {
    const plan = createBinbDescramblePlan(fKey('-'), fKey('+', true), 864, 864);

    expect(plan).toMatchObject({ outputWidth: 800, outputHeight: 800, variant: 'F' });
    expect(plan.moves).toHaveLength(64);
    expect(plan.moves[0]).toEqual({
      sourceX: 4,
      sourceY: 4,
      width: 100,
      height: 100,
      destinationX: 100,
      destinationY: 0,
    });
    expect(plan.moves[1]).toEqual(expect.objectContaining({
      sourceX: 112,
      destinationX: 0,
      destinationY: 0,
    }));
  });

  it('decodes the legacy A table and preserves uncovered right and bottom edges', () => {
    const plan = createBinbDescramblePlan(aKey(true), aKey(), 805, 803);

    expect(plan).toMatchObject({ outputWidth: 805, outputHeight: 803, variant: 'A' });
    expect(plan.moves).toHaveLength(66);
    expect(plan.moves[0]).toEqual(expect.objectContaining({
      sourceX: 0,
      sourceY: 0,
      destinationX: 112,
      destinationY: 0,
    }));
    expect(plan.moves.at(-2)).toEqual(expect.objectContaining({ width: 5 }));
    expect(plan.moves.at(-1)).toEqual(expect.objectContaining({ height: 3 }));
  });

  it('fails closed for an unknown coordinate table', () => {
    expect(() => createBinbDescramblePlan('unknown', 'also-unknown', 800, 800))
      .toThrow(/未知.*拼图/u);
  });

  it('projects the deterministic plan to a PNG file without retaining the source bitmap', async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 864, height: 864, close })));
    const context = { drawImage, imageSmoothingEnabled: true };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const document = {
      createElement: (name: string) => name === 'canvas' ? canvas : null,
    } as unknown as Document;
    const signal = new AbortController().signal;

    const file = await restoreBinbPageImage(
      new Blob(['scrambled'], { type: 'image/jpeg' }),
      {
        pageIndex: 0,
        src: 'pages/page-1.jpg',
        width: 800,
        height: 800,
        scrambleSourceKey: fKey('-'),
        scrambleDestinationKey: fKey('+', true),
      },
      signal,
      document,
    );

    expect(file).toMatchObject({ name: 'binb-page-1.png', type: 'image/png' });
    expect(canvas).toMatchObject({ width: 800, height: 800 });
    expect(drawImage).toHaveBeenCalledTimes(64);
    expect(close).toHaveBeenCalledOnce();
  });

  it('restores a synthetic scrambled pixel matrix exactly', async () => {
    const plan = createBinbDescramblePlan(fKey('-'), fKey('+', true), 864, 864);
    const sourcePixels = new Uint32Array(864 * 864);
    const expectedPixels = new Uint32Array(800 * 800);
    for (let y = 0; y < 800; y += 1) {
      for (let x = 0; x < 800; x += 1) expectedPixels[y * 800 + x] = y * 800 + x + 1;
    }
    for (const move of plan.moves) {
      for (let y = 0; y < move.height; y += 1) {
        for (let x = 0; x < move.width; x += 1) {
          sourcePixels[(move.sourceY + y) * 864 + move.sourceX + x]
            = expectedPixels[(move.destinationY + y) * 800 + move.destinationX + x];
        }
      }
    }
    const outputPixels = new Uint32Array(800 * 800);
    const bitmap = { width: 864, height: 864, pixels: sourcePixels, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const context = {
      imageSmoothingEnabled: true,
      drawImage: (
        source: typeof bitmap,
        sourceX: number,
        sourceY: number,
        width: number,
        height: number,
        destinationX: number,
        destinationY: number,
      ) => {
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            outputPixels[(destinationY + y) * 800 + destinationX + x]
              = source.pixels[(sourceY + y) * 864 + sourceX + x];
          }
        }
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const document = { createElement: () => canvas } as unknown as Document;

    await restoreBinbPageImage(
      new Blob(['synthetic']),
      {
        pageIndex: 0,
        src: 'synthetic.jpg',
        width: 800,
        height: 800,
        scrambleSourceKey: fKey('-'),
        scrambleDestinationKey: fKey('+', true),
      },
      new AbortController().signal,
      document,
    );

    expect(outputPixels).toEqual(expectedPixels);
  });
});

describe('BinB page acquisition', () => {
  it('refreshes metadata once when the initial signed metadata/content request fails', async () => {
    const value: BinbManifest = {
      cid,
      serverType: 2,
      viewMode: 2,
      contentBaseUrl: 'https://cdn.example/book/',
      imageClass: 'multiquality',
      readerUrl: 'https://reader.example/viewer/?cid=chapter-1',
      scrambleTables: { stbl: [1], ttbl: [1], ptbl: ['x'], ctbl: ['y'] },
      pages: [{
        pageIndex: 0,
        src: 'page.jpg',
        width: 800,
        height: 800,
        scrambleSourceKey: fKey('-'),
        scrambleDestinationKey: fKey('+'),
      }],
    };
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('metadata token expired'))
      .mockResolvedValueOnce(value);
    const raw = new Blob(['raw'], { type: 'image/jpeg' });
    const restored = new File(['restored'], 'restored.png');

    await expect(acquireBinbPageFile(
      0,
      createBinbContextKey(cid, value.readerUrl),
      { read },
      'low',
      vi.fn(async () => ({ blob: raw, file: new File([raw], 'raw.jpg') })),
      vi.fn(async () => restored),
      new AbortController().signal,
    )).resolves.toBe(restored);
    expect(read).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      signal: expect.any(AbortSignal),
    });
  });

  it('refreshes metadata once after an image-token failure while the reading context is unchanged', async () => {
    const baseManifest: BinbManifest = {
      cid,
      serverType: 0,
      viewMode: 1,
      contentBaseUrl: 'https://cdn.example/books/current/',
      requestToken: 'expired-token',
      contentDate: '1',
      imageClass: 'multiquality',
      readerUrl: 'https://reader.example/viewer/?cid=chapter-1',
      scrambleTables: { stbl: [1], ttbl: [1], ptbl: ['x'], ctbl: ['y'] },
      pages: [{
        pageIndex: 0,
        src: 'pages/page-1.jpg',
        width: 800,
        height: 800,
        scrambleSourceKey: fKey('-'),
        scrambleDestinationKey: fKey('+'),
      }],
    };
    const refreshedManifest = { ...baseManifest, requestToken: 'fresh-token', contentDate: '2' };
    const read = vi.fn(async (options?: { forceRefresh?: boolean }) => (
      options?.forceRefresh ? refreshedManifest : baseManifest
    ));
    const raw = new Blob(['raw'], { type: 'image/jpeg' });
    const rawFile = new File([raw], 'raw.jpg', { type: raw.type });
    const downloadImage = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 403'))
      .mockResolvedValueOnce({ blob: raw, file: rawFile });
    const restored = new File(['restored'], 'restored.png', { type: 'image/png' });
    const restoreImage = vi.fn(async () => restored);
    const expectedContextKey = createBinbContextKey(cid, baseManifest.readerUrl);

    const result = await acquireBinbPageFile(
      0,
      expectedContextKey,
      { read },
      'high',
      downloadImage,
      restoreImage,
      new AbortController().signal,
    );

    expect(result).toBe(restored);
    expect(read).toHaveBeenNthCalledWith(1, { signal: expect.any(AbortSignal) });
    expect(read).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      signal: expect.any(AbortSignal),
    });
    expect(downloadImage).toHaveBeenCalledTimes(2);
    expect(downloadImage.mock.calls[0][0]).toMatchObject({
      kind: 'remote-image',
      allowedBaseUrl: 'https://cdn.example/books/current/',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    expect(downloadImage.mock.calls[0][0].url).toContain('p=expired-token');
    expect(downloadImage.mock.calls[0][0].url).toContain('q=0');
    expect(downloadImage.mock.calls[1][0].url).toContain('p=fresh-token');
    expect(restoreImage).toHaveBeenCalledOnce();
  });

  it('rejects a refreshed manifest that belongs to another reading context', async () => {
    const manifest = {
      cid,
      serverType: 2 as const,
      viewMode: 2 as const,
      contentBaseUrl: 'https://cdn.example/book/',
      imageClass: 'multiquality' as const,
      readerUrl: 'https://reader.example/viewer/?cid=chapter-1',
      scrambleTables: { stbl: [1], ttbl: [1], ptbl: ['x'], ctbl: ['y'] },
      pages: [{
        pageIndex: 0,
        src: 'page.jpg',
        width: 800,
        height: 800,
        scrambleSourceKey: fKey('-'),
        scrambleDestinationKey: fKey('+'),
      }],
    } satisfies BinbManifest;
    const read = vi.fn()
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce({ ...manifest, cid: 'another-chapter' });

    await expect(acquireBinbPageFile(
      0,
      createBinbContextKey(cid, manifest.readerUrl),
      { read },
      'low',
      vi.fn(async () => { throw new Error('expired'); }),
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow(/上下文已变化/u);
  });
});
