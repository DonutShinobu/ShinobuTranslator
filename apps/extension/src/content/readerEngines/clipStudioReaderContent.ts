import type { DownloadImageForTranslation } from '../core/translation/imageTranslationExecution';

const defaultPageLimit = 200;

export class ClipStudioReaderInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipStudioReaderInvalidResponseError';
  }
}

export class ClipStudioReaderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipStudioReaderUnsupportedError';
  }
}

export type ClipStudioReaderResourceRequest = {
  url: string;
  allowedBaseUrl: string;
};

export type ClipStudioReaderResourceResponse = {
  text: string;
  contentType: string;
  sourceUrl: string;
};

export type ClipStudioReaderResourceFetcher = (
  request: ClipStudioReaderResourceRequest,
  options?: { signal?: AbortSignal },
) => Promise<ClipStudioReaderResourceResponse>;

export type ClipStudioReaderFace = {
  totalPages: number;
  contentWidth: number;
  contentHeight: number;
  scrambleColumns: number;
  scrambleRows: number;
  binding: 0 | 1;
  startPage: 0 | 1;
  doublePageIndices: readonly number[];
  blankSingleIndices: readonly number[];
};

export type ClipStudioReaderSpread = {
  pageIndex: number;
  singleStartIndex: number;
  singleCount: number;
  isDoublePage: boolean;
  leftPageIndex: number | null;
  rightPageIndex: number | null;
  physicalPageIndices: readonly number[];
};

export type ClipStudioReaderManifest = {
  face: ClipStudioReaderFace;
  spreads: readonly ClipStudioReaderSpread[];
};

export type ClipStudioReaderPage = {
  pageIndex: number;
  imageFileName: string;
  scrambled: boolean;
  scrambleTable: readonly number[];
};

export type ClipStudioReaderContentClient = {
  read(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<ClipStudioReaderManifest>;
  readPage(
    pageIndex: number,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<ClipStudioReaderPage>;
  imageRequest(page: ClipStudioReaderPage): ClipStudioReaderResourceRequest;
};

function xmlBlock(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'iu').exec(xml);
  return match?.[1] ?? null;
}

function requiredText(xml: string, tag: string, label: string): string {
  const value = xmlBlock(xml, tag)?.replace(/<[^>]+>/gu, '').trim();
  if (!value) throw new ClipStudioReaderInvalidResponseError(`CLIP ${label} 缺失`);
  return value;
}

function requiredInteger(
  xml: string,
  tag: string,
  label: string,
  options: { min: number; max: number },
): number {
  const value = Number(requiredText(xml, tag, label));
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new ClipStudioReaderInvalidResponseError(`CLIP ${label} 无效`);
  }
  return value;
}

function optionalIndexList(xml: string, tag: string, maxExclusive: number): number[] {
  const value = xmlBlock(xml, tag)?.replace(/<[^>]+>/gu, '').trim();
  if (!value) return [];
  const parsed = value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map(Number);
  if (parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 0 || entry >= maxExclusive)) {
    throw new ClipStudioReaderInvalidResponseError(`CLIP ${tag} 无效`);
  }
  return [...new Set(parsed)].sort((left, right) => left - right);
}

export function parseClipStudioReaderFace(
  text: string,
  pageLimit = defaultPageLimit,
): ClipStudioReaderFace {
  const face = xmlBlock(text, 'Face');
  if (!face) throw new ClipStudioReaderInvalidResponseError('CLIP Face 根节点缺失');
  const contentType = requiredInteger(face, 'ContentType', 'ContentType', { min: 0, max: 99 });
  if (contentType !== 3) {
    throw new ClipStudioReaderUnsupportedError(`仅支持固定版式 ContentType=3，当前为 ${contentType}`);
  }
  const totalPages = requiredInteger(face, 'TotalPage', 'TotalPage', { min: 1, max: 100_000 });
  if (totalPages > pageLimit) {
    throw new ClipStudioReaderUnsupportedError(`页数 ${totalPages} 超过上限 ${pageLimit}`);
  }
  const bindingValue = requiredInteger(face, 'Binding', 'Binding', { min: 0, max: 1 });
  const startPageValue = requiredInteger(face, 'StartPage', 'StartPage', { min: 0, max: 1 });
  const contentFrame = xmlBlock(face, 'ContentFrame');
  const scramble = xmlBlock(face, 'Scramble');
  if (!contentFrame || !scramble) {
    throw new ClipStudioReaderInvalidResponseError('CLIP 版面或扰码尺寸缺失');
  }
  return {
    totalPages,
    contentWidth: requiredInteger(contentFrame, 'Width', '内容宽度', {
      min: 1,
      max: 100_000,
    }),
    contentHeight: requiredInteger(contentFrame, 'Height', '内容高度', {
      min: 1,
      max: 100_000,
    }),
    scrambleColumns: requiredInteger(scramble, 'Width', '扰码列数', { min: 1, max: 64 }),
    scrambleRows: requiredInteger(scramble, 'Height', '扰码行数', { min: 1, max: 64 }),
    binding: bindingValue as 0 | 1,
    startPage: startPageValue as 0 | 1,
    doublePageIndices: optionalIndexList(face, 'DoublePagesMap', totalPages),
    blankSingleIndices: optionalIndexList(face, 'BlankPagesMap', totalPages * 2 + 2),
  };
}

type SingleSlot = {
  physicalPageIndex: number | null;
  doublePage: boolean;
};

export function createClipStudioReaderSpreads(
  face: ClipStudioReaderFace,
): ClipStudioReaderSpread[] {
  const doublePages = new Set(face.doublePageIndices);
  const singles: SingleSlot[] = [];
  for (let pageIndex = 0; pageIndex < face.totalPages; pageIndex += 1) {
    const doublePage = doublePages.has(pageIndex);
    singles.push({ physicalPageIndex: pageIndex, doublePage });
    if (doublePage) singles.push({ physicalPageIndex: pageIndex, doublePage });
  }
  for (const blankIndex of [...face.blankSingleIndices].sort((left, right) => right - left)) {
    singles.splice(blankIndex, 0, { physicalPageIndex: null, doublePage: false });
  }
  if (face.binding + face.startPage === 1) {
    singles.unshift({ physicalPageIndex: null, doublePage: false });
  }

  const spreads: ClipStudioReaderSpread[] = [];
  let singleIndex = 0;
  while (singleIndex < singles.length) {
    const first = singles[singleIndex]!;
    if (first.doublePage && first.physicalPageIndex !== null) {
      const repeated = singles[singleIndex + 1];
      const singleCount = repeated?.doublePage
        && repeated.physicalPageIndex === first.physicalPageIndex
        ? 2
        : 1;
      spreads.push({
        pageIndex: spreads.length,
        singleStartIndex: singleIndex,
        singleCount,
        isDoublePage: true,
        leftPageIndex: first.physicalPageIndex,
        rightPageIndex: null,
        physicalPageIndices: [first.physicalPageIndex],
      });
      singleIndex += singleCount;
      continue;
    }

    const candidate = singles[singleIndex + 1];
    const second = candidate && !candidate.doublePage
      ? candidate
      : { physicalPageIndex: null, doublePage: false };
    const singleCount = candidate && !candidate.doublePage ? 2 : 1;
    const left = face.binding === 0 ? second : first;
    const right = face.binding === 0 ? first : second;
    const physicalPageIndices = [left.physicalPageIndex, right.physicalPageIndex]
      .filter((entry): entry is number => entry !== null);
    spreads.push({
      pageIndex: spreads.length,
      singleStartIndex: singleIndex,
      singleCount,
      isDoublePage: false,
      leftPageIndex: left.physicalPageIndex,
      rightPageIndex: right.physicalPageIndex,
      physicalPageIndices: [...new Set(physicalPageIndices)],
    });
    singleIndex += singleCount;
  }
  return spreads;
}

export function parseClipStudioReaderPage(
  text: string,
  face: ClipStudioReaderFace,
  expectedPageIndex: number,
): ClipStudioReaderPage {
  const page = xmlBlock(text, 'Page');
  if (!page) throw new ClipStudioReaderInvalidResponseError('CLIP Page 根节点缺失');
  const pageIndex = requiredInteger(page, 'PageNo', 'PageNo', { min: 0, max: face.totalPages - 1 });
  if (pageIndex !== expectedPageIndex) {
    throw new ClipStudioReaderInvalidResponseError('CLIP PageNo 与请求不一致');
  }
  const partCount = requiredInteger(page, 'PartCount', 'PartCount', { min: 1, max: 10_000 });
  const parts = [...page.matchAll(/<Part\b[^>]*>([\s\S]*?)<\/Part>/giu)].map((match) => match[1]!);
  if (partCount !== 1 || parts.length !== 1) {
    throw new ClipStudioReaderUnsupportedError(`暂不支持 PartCount=${partCount} 的分片页`);
  }
  const kindMatch = /<Kind\b([^>]*)>([\s\S]*?)<\/Kind>/iu.exec(parts[0]!);
  const kindAttributes = kindMatch?.[1] ?? '';
  const partNumber = /\bNo\s*=\s*["'](\d{4})["']/iu.exec(kindAttributes)?.[1];
  if (!kindMatch || !partNumber) {
    throw new ClipStudioReaderInvalidResponseError('CLIP Part No 无效');
  }
  const scrambled = /\bscramble\s*=\s*["']1["']/iu.test(kindAttributes);
  const expectedTableLength = face.scrambleColumns * face.scrambleRows;
  const scrambleTable = scrambled
    ? requiredText(page, 'Scramble', 'Scramble').split(/[\s,]+/u).filter(Boolean).map(Number)
    : [];
  if (
    scrambled
    && (
      scrambleTable.length !== expectedTableLength
      || scrambleTable.some((entry) => !Number.isSafeInteger(entry) || entry < 0 || entry >= expectedTableLength)
      || new Set(scrambleTable).size !== expectedTableLength
    )
  ) {
    throw new ClipStudioReaderInvalidResponseError('CLIP Scramble 不是有效排列');
  }
  return {
    pageIndex,
    imageFileName: `${String(pageIndex).padStart(4, '0')}_${partNumber}.bin`,
    scrambled,
    scrambleTable,
  };
}

function allowedBaseForEndpoint(endpoint: URL): string {
  const directory = endpoint.pathname.slice(0, endpoint.pathname.lastIndexOf('/') + 1);
  return `${endpoint.origin}${directory || '/'}`;
}

export function buildClipStudioReaderRequest(
  templateUrl: string,
  mode: 1 | 7 | 8,
  fileName: string,
  now = Date.now(),
): ClipStudioReaderResourceRequest {
  const url = new URL(templateUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ClipStudioReaderInvalidResponseError('CLIP 资源端点必须是无凭据 HTTPS 地址');
  }
  url.searchParams.set('mode', String(mode));
  url.searchParams.set('file', fileName);
  url.searchParams.set('reqtype', '0');
  if (url.searchParams.has('time')) url.searchParams.set('time', String(now));
  return { url: url.href, allowedBaseUrl: allowedBaseForEndpoint(url) };
}

function assertResourceResponse(
  response: ClipStudioReaderResourceResponse,
  request: ClipStudioReaderResourceRequest,
): void {
  if (response.sourceUrl !== request.url) {
    throw new ClipStudioReaderInvalidResponseError('CLIP 资源请求发生重定向');
  }
}

export function createClipStudioReaderContentClient(options: {
  templateUrl: string;
  fetchResource: ClipStudioReaderResourceFetcher;
  now?: () => number;
  pageLimit?: number;
}): ClipStudioReaderContentClient {
  let manifestCache: Promise<ClipStudioReaderManifest> | null = null;
  const pageCache = new Map<number, Promise<ClipStudioReaderPage>>();
  const now = options.now ?? Date.now;

  const readManifest = async (signal?: AbortSignal): Promise<ClipStudioReaderManifest> => {
    const request = buildClipStudioReaderRequest(options.templateUrl, 7, 'face.xml', now());
    const response = await options.fetchResource(request, { signal });
    assertResourceResponse(response, request);
    const face = parseClipStudioReaderFace(response.text, options.pageLimit ?? defaultPageLimit);
    return { face, spreads: createClipStudioReaderSpreads(face) };
  };

  const readPage = async (
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<ClipStudioReaderPage> => {
    const manifest = await (manifestCache ??= readManifest(signal));
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= manifest.face.totalPages) {
      throw new ClipStudioReaderInvalidResponseError('CLIP 物理页序号无效');
    }
    const request = buildClipStudioReaderRequest(
      options.templateUrl,
      8,
      `${String(pageIndex).padStart(4, '0')}.xml`,
      now(),
    );
    const response = await options.fetchResource(request, { signal });
    assertResourceResponse(response, request);
    return parseClipStudioReaderPage(response.text, manifest.face, pageIndex);
  };

  return {
    read({ forceRefresh = false, signal } = {}) {
      if (forceRefresh) manifestCache = null;
      manifestCache ??= readManifest(signal).catch((error) => {
        manifestCache = null;
        throw error;
      });
      return manifestCache;
    },
    readPage(pageIndex, { forceRefresh = false, signal } = {}) {
      if (forceRefresh) pageCache.delete(pageIndex);
      let cached = pageCache.get(pageIndex);
      if (!cached) {
        cached = readPage(pageIndex, signal).catch((error) => {
          pageCache.delete(pageIndex);
          throw error;
        });
        pageCache.set(pageIndex, cached);
      }
      return cached;
    },
    imageRequest(page) {
      return buildClipStudioReaderRequest(options.templateUrl, 1, page.imageFileName, now());
    },
  };
}

function canvasToFile(canvas: HTMLCanvasElement, fileName: string, signal: AbortSignal): Promise<File> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (!blob) {
        reject(new Error('CLIP Canvas 导出失败'));
        return;
      }
      resolve(new File([blob], fileName, { type: 'image/png' }));
    }, 'image/png');
  });
}

export async function restoreClipStudioReaderPageImage(
  blob: Blob,
  page: ClipStudioReaderPage,
  face: ClipStudioReaderFace,
  document: Document,
  signal: AbortSignal,
): Promise<File> {
  if (signal.aborted) throw signal.reason;
  const bitmap = await createImageBitmap(blob);
  try {
    const output = document.createElement('canvas');
    output.width = bitmap.width;
    output.height = bitmap.height;
    const context = output.getContext('2d');
    if (!context) throw new Error('CLIP Canvas 2D 不可用');
    context.drawImage(bitmap, 0, 0);
    if (page.scrambled) {
      const transfer = document.createElement('canvas');
      transfer.width = bitmap.width;
      transfer.height = bitmap.height;
      const transferContext = transfer.getContext('2d');
      if (!transferContext) throw new Error('CLIP 中转 Canvas 2D 不可用');
      transferContext.drawImage(bitmap, 0, 0);
      const tileWidth = 8 * Math.floor(Math.floor(bitmap.width / face.scrambleColumns) / 8);
      const tileHeight = 8 * Math.floor(Math.floor(bitmap.height / face.scrambleRows) / 8);
      if (tileWidth <= 0 || tileHeight <= 0) {
        throw new ClipStudioReaderUnsupportedError('CLIP 扰码网格大于图像尺寸');
      }
      for (let destination = 0; destination < page.scrambleTable.length; destination += 1) {
        const source = page.scrambleTable[destination]!;
        const destinationX = (destination % face.scrambleColumns) * tileWidth;
        const destinationY = Math.floor(destination / face.scrambleColumns) * tileHeight;
        const sourceX = (source % face.scrambleColumns) * tileWidth;
        const sourceY = Math.floor(source / face.scrambleColumns) * tileHeight;
        context.clearRect(destinationX, destinationY, tileWidth, tileHeight);
        context.drawImage(
          transfer,
          sourceX,
          sourceY,
          tileWidth,
          tileHeight,
          destinationX,
          destinationY,
          tileWidth,
          tileHeight,
        );
      }
    }
    return await canvasToFile(output, `clip-studio-${page.pageIndex + 1}.png`, signal);
  } finally {
    bitmap.close();
  }
}

function drawContained(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  left: number,
  top: number,
  width: number,
  height: number,
  horizontalAlignment: 'left' | 'center' | 'right',
): void {
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  const drawLeft = horizontalAlignment === 'left'
    ? left
    : horizontalAlignment === 'right'
      ? left + width - drawWidth
      : left + (width - drawWidth) / 2;
  context.drawImage(
    bitmap,
    drawLeft,
    top + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export async function composeClipStudioReaderSpread(
  spread: ClipStudioReaderSpread,
  pages: ReadonlyMap<number, File>,
  pageWidth: number,
  pageHeight: number,
  document: Document,
  signal: AbortSignal,
): Promise<File> {
  if (
    !Number.isSafeInteger(pageWidth)
    || !Number.isSafeInteger(pageHeight)
    || pageWidth <= 0
    || pageHeight <= 0
  ) {
    throw new Error('CLIP 固有页面尺寸无效');
  }
  const output = document.createElement('canvas');
  output.width = spread.isDoublePage ? pageWidth : pageWidth * 2;
  output.height = pageHeight;
  const context = output.getContext('2d');
  if (!context) throw new Error('CLIP Canvas 2D 不可用');
  const bitmaps = new Map<number, ImageBitmap>();
  try {
    for (const pageIndex of spread.physicalPageIndices) {
      const file = pages.get(pageIndex);
      if (!file) throw new Error(`CLIP 第 ${pageIndex + 1} 页未准备`);
      bitmaps.set(pageIndex, await createImageBitmap(file));
    }
    if (spread.isDoublePage) {
      const pageIndex = spread.physicalPageIndices[0];
      const bitmap = pageIndex === undefined ? undefined : bitmaps.get(pageIndex);
      if (!bitmap) throw new Error('CLIP 跨页图像缺失');
      drawContained(context, bitmap, 0, 0, pageWidth, pageHeight, 'center');
    } else {
      if (spread.leftPageIndex !== null) {
        const bitmap = bitmaps.get(spread.leftPageIndex);
        if (bitmap) drawContained(context, bitmap, 0, 0, pageWidth, pageHeight, 'right');
      }
      if (spread.rightPageIndex !== null) {
        const bitmap = bitmaps.get(spread.rightPageIndex);
        if (bitmap) {
          drawContained(context, bitmap, pageWidth, 0, pageWidth, pageHeight, 'left');
        }
      }
    }
    return await canvasToFile(output, `clip-studio-spread-${spread.pageIndex + 1}.png`, signal);
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close();
  }
}

export async function acquireClipStudioReaderSpreadFile(options: {
  spread: ClipStudioReaderSpread;
  manifest: ClipStudioReaderManifest;
  client: ClipStudioReaderContentClient;
  downloadImage: DownloadImageForTranslation;
  document: Document;
  signal: AbortSignal;
}): Promise<File> {
  const restoredPages = new Map<number, File>();
  for (const pageIndex of options.spread.physicalPageIndices) {
    if (options.signal.aborted) throw options.signal.reason;
    const page = await options.client.readPage(pageIndex, { signal: options.signal });
    const request = options.client.imageRequest(page);
    const downloaded = await options.downloadImage(
      {
        kind: 'remote-image',
        url: request.url,
        allowedBaseUrl: request.allowedBaseUrl,
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { signal: options.signal },
    );
    restoredPages.set(
      pageIndex,
      await restoreClipStudioReaderPageImage(
        downloaded.blob,
        page,
        options.manifest.face,
        options.document,
        options.signal,
      ),
    );
  }
  return composeClipStudioReaderSpread(
    options.spread,
    restoredPages,
    options.manifest.face.contentWidth,
    options.manifest.face.contentHeight,
    options.document,
    options.signal,
  );
}
