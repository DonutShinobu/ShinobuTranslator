import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClipStudioReaderRequest,
  ClipStudioReaderInvalidResponseError,
  ClipStudioReaderUnsupportedError,
  createClipStudioReaderContentClient,
  createClipStudioReaderSpreads,
  composeClipStudioReaderSpread,
  parseClipStudioReaderFace,
  parseClipStudioReaderPage,
} from '../../../apps/extension/src/content/readerEngines/clipStudioReaderContent';

const faceXml = `
  <Face>
    <ContentFrame><Width>1440</Width><Height>2048</Height></ContentFrame>
    <ContentType>3</ContentType>
    <TotalPage>3</TotalPage>
    <DoublePages><InDoublePages>4</InDoublePages><DoublePagesMap>0</DoublePagesMap></DoublePages>
    <Scramble><Width>4</Width><Height>4</Height></Scramble>
    <Binding>0</Binding>
    <StartPage>0</StartPage>
  </Face>
`;

function pageXml(pageIndex: number, table = '3,9,7,0,15,1,8,5,10,4,13,2,12,6,14,11') {
  return `
    <Page>
      <PageNo>${pageIndex}</PageNo>
      <PartCount>1</PartCount>
      <Part><Kind scramble="1" No="0000">1</Kind></Part>
      <Scramble>${table}</Scramble>
    </Page>
  `;
}

describe('CLIP STUDIO READER content protocol', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses fixed-layout face.xml and maps double plus paired physical pages to spreads', () => {
    const face = parseClipStudioReaderFace(faceXml);

    expect(face).toMatchObject({
      totalPages: 3,
      contentWidth: 1440,
      contentHeight: 2048,
      scrambleColumns: 4,
      scrambleRows: 4,
      binding: 0,
      doublePageIndices: [0],
    });
    expect(createClipStudioReaderSpreads(face)).toEqual([
      {
        pageIndex: 0,
        singleStartIndex: 0,
        singleCount: 2,
        isDoublePage: true,
        leftPageIndex: 0,
        rightPageIndex: null,
        physicalPageIndices: [0],
      },
      {
        pageIndex: 1,
        singleStartIndex: 2,
        singleCount: 2,
        isDoublePage: false,
        leftPageIndex: 2,
        rightPageIndex: 1,
        physicalPageIndices: [2, 1],
      },
    ]);
  });

  it('honors an inserted leading blank and left-to-right binding', () => {
    const spreads = createClipStudioReaderSpreads({
      totalPages: 3,
      contentWidth: 1000,
      contentHeight: 1500,
      scrambleColumns: 4,
      scrambleRows: 4,
      binding: 1,
      startPage: 0,
      doublePageIndices: [],
      blankSingleIndices: [],
    });

    expect(spreads.map(({ leftPageIndex, rightPageIndex, singleStartIndex }) => ({
      leftPageIndex,
      rightPageIndex,
      singleStartIndex,
    }))).toEqual([
      { leftPageIndex: null, rightPageIndex: 0, singleStartIndex: 0 },
      { leftPageIndex: 1, rightPageIndex: 2, singleStartIndex: 2 },
    ]);
  });

  it('parses a one-part page and validates the official scramble permutation', () => {
    const face = parseClipStudioReaderFace(faceXml);

    expect(parseClipStudioReaderPage(pageXml(2), face, 2)).toEqual({
      pageIndex: 2,
      imageFileName: '0002_0000.bin',
      scrambled: true,
      scrambleTable: [3, 9, 7, 0, 15, 1, 8, 5, 10, 4, 13, 2, 12, 6, 14, 11],
    });
    expect(() => parseClipStudioReaderPage(pageXml(2, '0,0'), face, 2))
      .toThrow(ClipStudioReaderInvalidResponseError);
  });

  it('rejects non-fixed-layout content and multi-part pages explicitly', () => {
    expect(() => parseClipStudioReaderFace(faceXml.replace('<ContentType>3', '<ContentType>2')))
      .toThrow(ClipStudioReaderUnsupportedError);
    const face = parseClipStudioReaderFace(faceXml);
    expect(() => parseClipStudioReaderPage(
      pageXml(0).replace('<PartCount>1</PartCount>', '<PartCount>2</PartCount>'),
      face,
      0,
    )).toThrow(ClipStudioReaderUnsupportedError);
  });

  it('derives same-endpoint face, page, and binary requests from the observed session URL', () => {
    const template = 'https://reader.example/api/diazepam_hybrid?mode=999&file=&reqtype=1&vm=4.3&param=session&time=1';

    expect(buildClipStudioReaderRequest(template, 7, 'face.xml', 123)).toEqual({
      url: 'https://reader.example/api/diazepam_hybrid?mode=7&file=face.xml&reqtype=0&vm=4.3&param=session&time=123',
      allowedBaseUrl: 'https://reader.example/api/',
    });
    expect(buildClipStudioReaderRequest(template, 1, '0001_0000.bin', 456).url)
      .toContain('mode=1&file=0001_0000.bin&reqtype=0');
  });

  it('caches face and page metadata while preserving explicit refresh', async () => {
    const fetchResource = vi.fn(async (request: { url: string }) => ({
      text: new URL(request.url).searchParams.get('mode') === '7' ? faceXml : pageXml(1),
      contentType: 'application/xml',
      sourceUrl: request.url,
    }));
    const client = createClipStudioReaderContentClient({
      templateUrl: 'https://reader.example/api/diazepam_hybrid?mode=7&file=face.xml&reqtype=0',
      fetchResource,
      now: () => 1,
    });

    await client.read();
    await client.read();
    await client.readPage(1);
    await client.readPage(1);
    expect(fetchResource).toHaveBeenCalledTimes(2);
    await client.read({ forceRefresh: true });
    expect(fetchResource).toHaveBeenCalledTimes(3);
  });

  it('composes paired pages in stable intrinsic page cells independent of the viewport', async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, fillRect }),
      toBlob: (callback: BlobCallback) => callback(new Blob(['spread'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const firstBitmap = { width: 100, height: 200, close: vi.fn() } as unknown as ImageBitmap;
    const secondBitmap = { width: 100, height: 200, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => (
      file.name === 'left.png' ? firstBitmap : secondBitmap
    )));

    await composeClipStudioReaderSpread(
      {
        pageIndex: 0,
        singleStartIndex: 0,
        singleCount: 2,
        isDoublePage: false,
        leftPageIndex: 0,
        rightPageIndex: 1,
        physicalPageIndices: [0, 1],
      },
      new Map([
        [0, new File(['left'], 'left.png')],
        [1, new File(['right'], 'right.png')],
      ]),
      100,
      200,
      { createElement: () => canvas } as unknown as Document,
      new AbortController().signal,
    );

    expect(canvas).toMatchObject({ width: 200, height: 200 });
    expect(fillRect).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenNthCalledWith(1, firstBitmap, 0, 0, 100, 200);
    expect(drawImage).toHaveBeenNthCalledWith(2, secondBitmap, 100, 0, 100, 200);
  });
});
