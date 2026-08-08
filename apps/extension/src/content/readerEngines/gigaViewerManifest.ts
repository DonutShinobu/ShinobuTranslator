import type { DownloadImageForTranslation } from '../core/translation/imageTranslationExecution';

const tileCount = 4;
const tileMultiple = 8;
const maxManifestPages = 2_000;
const maxImageDimension = 20_000;

export const gigaViewerTranslateAllPageLimit = 200;

export type GigaViewerReadingDirection = 'rtl' | 'ltr' | 'ttb';
export type GigaViewerImageMode = 'baku' | 'raw' | 'unsupported';

export type GigaViewerPageDescriptor = {
  pageIndex: number;
  manifestIndex: number;
  imageUrl: string;
  width: number;
  height: number;
  imageMode: GigaViewerImageMode;
  isGif: boolean;
};

export type GigaViewerManifest = {
  productId: string;
  productType: 'episode' | 'magazine' | 'volume';
  permalink: string;
  imageUrisDigest: string;
  readingDirection: string;
  supportedDirection: boolean;
  imageMode: GigaViewerImageMode;
  pages: readonly GigaViewerPageDescriptor[];
  manifestPageCount: number;
};

export type GigaViewerBakuTileMove = {
  sourceColumn: number;
  sourceRow: number;
  destinationColumn: number;
  destinationRow: number;
};

export type GigaViewerManifestSource = {
  read(): GigaViewerManifest | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, maximum: number): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function parseNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseImageMode(value: unknown): GigaViewerImageMode {
  if (value === 'baku') return 'baku';
  // GigaViewer's legacy/raw mode is called usagi. Older payloads omitted the
  // field and the viewer treated the source as an ordinary image as well.
  if (value === 'usagi' || value === undefined || value === null || value === '') return 'raw';
  return 'unsupported';
}

export function parseGigaViewerManifest(value: unknown): GigaViewerManifest | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || !isRecord(parsed.readableProduct)) return null;
  const product = parsed.readableProduct;
  if (!isRecord(product.pageStructure)) return null;
  const structure = product.pageStructure;
  if (!Array.isArray(structure.pages) || structure.pages.length > maxManifestPages) return null;

  const productId = parseNonEmptyString(product.id);
  const productType = product.typeName;
  const permalink = parseHttpsUrl(product.permalink);
  const imageUrisDigest = parseNonEmptyString(product.imageUrisDigest);
  const readingDirection = parseNonEmptyString(structure.readingDirection);
  if (
    !productId
    || (productType !== 'episode' && productType !== 'magazine' && productType !== 'volume')
    || !permalink
    || !imageUrisDigest
    || !readingDirection
  ) {
    return null;
  }

  const imageMode = parseImageMode(structure.choJuGiga);
  const pages: GigaViewerPageDescriptor[] = [];
  for (let manifestIndex = 0; manifestIndex < structure.pages.length; manifestIndex += 1) {
    const item = structure.pages[manifestIndex];
    if (!isRecord(item)) return null;
    if (item.type !== 'main') continue;
    const imageUrl = parseHttpsUrl(item.src);
    const width = parsePositiveInteger(item.width, maxImageDimension);
    const height = parsePositiveInteger(item.height, maxImageDimension);
    if (!imageUrl || !width || !height || width * height > 100_000_000) return null;
    pages.push({
      pageIndex: pages.length,
      manifestIndex,
      imageUrl,
      width,
      height,
      imageMode,
      isGif: item.isGif === true || /\.gif(?:$|[?#])/i.test(imageUrl),
    });
  }
  if (pages.length === 0) return null;

  return {
    productId,
    productType,
    permalink,
    imageUrisDigest,
    readingDirection,
    supportedDirection: ['rtl', 'ltr', 'ttb'].includes(readingDirection),
    imageMode,
    pages,
    manifestPageCount: structure.pages.length,
  };
}

export function readGigaViewerManifest(document: Document): GigaViewerManifest | null {
  const element = document.querySelector<HTMLElement>('#episode-json[data-value]')
    ?? document.querySelector<HTMLElement>('#episode-json');
  const value = element?.getAttribute('data-value') ?? element?.dataset?.value;
  return value ? parseGigaViewerManifest(value) : null;
}

export function createGigaViewerContextKey(
  manifest: GigaViewerManifest,
  location: Pick<Location, 'origin' | 'pathname'>,
): string {
  return [
    'giga-viewer',
    manifest.productType,
    manifest.productId,
    manifest.imageUrisDigest,
    `${location.origin}${location.pathname}`,
  ].join(':');
}

export function createGigaViewerBakuTileMoves(): readonly GigaViewerBakuTileMove[] {
  return Array.from({ length: tileCount * tileCount }, (_, sourceIndex) => {
    const sourceColumn = sourceIndex % tileCount;
    const sourceRow = Math.floor(sourceIndex / tileCount);
    return {
      sourceColumn,
      sourceRow,
      destinationColumn: sourceRow,
      destinationRow: sourceColumn,
    };
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) {
        reject(signal.reason);
      } else if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to export restored GigaViewer page'));
      }
    }, 'image/png');
  });
}

export async function restoreGigaViewerPageImage(
  rawImage: Blob,
  page: GigaViewerPageDescriptor,
  signal: AbortSignal,
  document: Document = globalThis.document,
): Promise<File> {
  if (signal.aborted) throw signal.reason;
  if (page.imageMode === 'unsupported') {
    throw new Error('Unsupported GigaViewer image mode');
  }
  const bitmap = await createImageBitmap(rawImage);
  try {
    if (signal.aborted) throw signal.reason;
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) throw new Error('Invalid GigaViewer source image dimensions');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, width, height, 0, 0, width, height);

    if (page.imageMode === 'baku') {
      const tileWidth = Math.floor(width / (tileCount * tileMultiple)) * tileMultiple;
      const tileHeight = Math.floor(height / (tileCount * tileMultiple)) * tileMultiple;
      if (tileWidth <= 0 || tileHeight <= 0) {
        throw new Error('GigaViewer source image is too small for baku restoration');
      }
      for (const move of createGigaViewerBakuTileMoves()) {
        context.drawImage(
          bitmap,
          move.sourceColumn * tileWidth,
          move.sourceRow * tileHeight,
          tileWidth,
          tileHeight,
          move.destinationColumn * tileWidth,
          move.destinationRow * tileHeight,
          tileWidth,
          tileHeight,
        );
      }
    }

    const restored = await canvasToBlob(canvas, signal);
    return new File(
      [restored],
      `giga-viewer-page-${page.pageIndex + 1}.png`,
      { type: 'image/png' },
    );
  } finally {
    bitmap.close();
  }
}

function readPage(
  pageIndex: number,
  expectedContextKey: string,
  source: GigaViewerManifestSource,
  location: Pick<Location, 'origin' | 'pathname'>,
): GigaViewerPageDescriptor {
  const manifest = source.read();
  if (!manifest || createGigaViewerContextKey(manifest, location) !== expectedContextKey) {
    throw new Error('GigaViewer reading context changed');
  }
  if (!manifest.supportedDirection) {
    throw new Error(`Unsupported GigaViewer reading direction: ${manifest.readingDirection}`);
  }
  if (manifest.imageMode === 'unsupported') {
    throw new Error('Unsupported GigaViewer image mode');
  }
  const page = manifest.pages[pageIndex];
  if (!page) throw new Error(`GigaViewer page ${pageIndex + 1} is unavailable`);
  return page;
}

export async function acquireGigaViewerPageFile(
  pageIndex: number,
  expectedContextKey: string,
  source: GigaViewerManifestSource,
  location: Pick<Location, 'origin' | 'pathname'>,
  downloadImage: DownloadImageForTranslation,
  restoreImage: typeof restoreGigaViewerPageImage,
  signal: AbortSignal,
): Promise<File> {
  let page = readPage(pageIndex, expectedContextKey, source, location);
  let downloaded;
  try {
    downloaded = await downloadImage(
      {
        kind: 'remote-image',
        url: page.imageUrl,
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { signal },
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    page = readPage(pageIndex, expectedContextKey, source, location);
    try {
      downloaded = await downloadImage(
        {
          kind: 'remote-image',
          url: page.imageUrl,
          referrerPolicy: 'strict-origin-when-cross-origin',
        },
        { signal },
      );
    } catch {
      throw error;
    }
  }

  if (page.imageMode === 'raw' && !page.isGif) return downloaded.file;
  return restoreImage(downloaded.blob, page, signal);
}
