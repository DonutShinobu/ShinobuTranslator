import type { DownloadImageForTranslation } from '../core/translation/imageTranslationExecution';

const tileCount = 4;
const maxChapterPages = 2_000;
const maxImageDimension = 20_000;
const signedUrlExpiryBufferMs = 30_000;

export type ComiciPageDescriptor = {
  pageIndex: number;
  imageUrl: string;
  scramble: readonly number[];
  width: number;
  height: number;
  expiresOn: number;
};

export type ComiciChapterManifest = {
  totalPages: number;
  pages: readonly ComiciPageDescriptor[];
};

export type ComiciTileMove = {
  sourceColumn: number;
  sourceRow: number;
  destinationColumn: number;
  destinationRow: number;
};

type ManifestParseContext = {
  viewerId: string;
  pageOrigin: string;
  requireComplete: boolean;
};

export type ComiciManifestClientDependencies = {
  root: HTMLElement;
  location: Pick<Location, 'origin'>;
  fetch: typeof fetch;
};

export interface ComiciManifestClient {
  loadComplete(signal: AbortSignal, force?: boolean): Promise<ComiciChapterManifest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, maximum: number): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

export function parseComiciScramble(value: unknown): readonly number[] | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== tileCount * tileCount) return null;
  if (parsed.some((item) => typeof item !== 'number')) return null;
  const values = parsed.map(Number);
  if (
    values.some((item) => !Number.isInteger(item) || item < 0 || item >= values.length)
    || new Set(values).size !== values.length
  ) {
    return null;
  }
  return values;
}

function isAllowedImageUrl(value: unknown, viewerId: string, pageOrigin: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const page = new URL(pageOrigin);
    const baseHost = page.hostname.replace(/^www\./, '');
    const allowedHosts = new Set([
      page.hostname,
      baseHost,
      `viewer.${baseHost}`,
    ]);
    const pathParts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && allowedHosts.has(url.hostname)
      && pathParts[0] === 'book'
      && pathParts[1] === viewerId;
  } catch {
    return false;
  }
}

export function parseComiciContentsInfo(
  value: unknown,
  context: ManifestParseContext,
): ComiciChapterManifest | null {
  if (!isRecord(value) || !Array.isArray(value.result)) return null;
  const totalPages = parsePositiveInteger(value.totalPages, maxChapterPages);
  if (!totalPages || value.result.length > totalPages) return null;

  const pages: ComiciPageDescriptor[] = [];
  const seen = new Set<number>();
  for (const item of value.result) {
    if (!isRecord(item)) return null;
    const pageIndex = Number(item.sort);
    const width = parsePositiveInteger(item.width, maxImageDimension);
    const height = parsePositiveInteger(item.height, maxImageDimension);
    const scramble = parseComiciScramble(item.scramble);
    const expiresOn = Number(item.expiresOn);
    if (
      !Number.isInteger(pageIndex)
      || pageIndex < 0
      || pageIndex >= totalPages
      || seen.has(pageIndex)
      || !width
      || !height
      || width * height > 100_000_000
      || !scramble
      || !Number.isFinite(expiresOn)
      || expiresOn <= 0
      || !isAllowedImageUrl(item.imageUrl, context.viewerId, context.pageOrigin)
    ) {
      return null;
    }
    seen.add(pageIndex);
    pages.push({
      pageIndex,
      imageUrl: item.imageUrl,
      scramble,
      width,
      height,
      expiresOn,
    });
  }

  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  if (
    context.requireComplete
    && (pages.length !== totalPages || pages.some((page, index) => page.pageIndex !== index))
  ) {
    return null;
  }
  return { totalPages, pages };
}

function createContentsInfoUrl(
  root: HTMLElement,
  location: Pick<Location, 'origin'>,
  pageFrom: number,
  pageTo: number,
): URL {
  const apiDomain = root.getAttribute('data-api-domain') || '/api';
  const apiBase = new URL(apiDomain.endsWith('/') ? apiDomain : `${apiDomain}/`, location.origin);
  if (apiBase.origin !== location.origin) {
    throw new Error('Comici metadata API must be same-origin');
  }
  const url = new URL('book/contentsInfo', apiBase);
  url.searchParams.set('user-id', root.getAttribute('data-member-jwt') ?? '');
  url.searchParams.set('comici-viewer-id', root.getAttribute('data-comici-viewer-id') ?? '');
  url.searchParams.set('page-from', String(pageFrom));
  url.searchParams.set('page-to', String(pageTo));
  const contentId = root.getAttribute('data-content-id');
  if (contentId) url.searchParams.set('contentId', contentId);
  return url;
}

export function createComiciManifestClient(
  dependencies: ComiciManifestClientDependencies,
): ComiciManifestClient {
  const viewerId = dependencies.root.getAttribute('data-comici-viewer-id') ?? '';
  let cached: ComiciChapterManifest | null = null;
  let activeLoad: Promise<ComiciChapterManifest> | null = null;

  const fetchRange = async (
    pageFrom: number,
    pageTo: number,
    requireComplete: boolean,
    signal: AbortSignal,
  ): Promise<ComiciChapterManifest> => {
    const response = await dependencies.fetch(
      createContentsInfoUrl(dependencies.root, dependencies.location, pageFrom, pageTo),
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal,
      },
    );
    if (!response.ok) throw new Error(`Comici metadata request failed (${response.status})`);
    const parsed = parseComiciContentsInfo(await response.json(), {
      viewerId,
      pageOrigin: dependencies.location.origin,
      requireComplete,
    });
    if (!parsed) throw new Error('Invalid Comici metadata response');
    return parsed;
  };

  return {
    async loadComplete(signal, force = false) {
      if (!force && cached) return cached;
      if (!force && activeLoad) return activeLoad;
      const load = (async () => {
        const initial = await fetchRange(0, 0, false, signal);
        const complete = initial.totalPages === 1 && initial.pages.length === 1
          ? initial
          : await fetchRange(0, initial.totalPages - 1, true, signal);
        cached = complete;
        return complete;
      })();
      activeLoad = load;
      try {
        return await load;
      } finally {
        if (activeLoad === load) activeLoad = null;
      }
    },
  };
}

export function createComiciTileMoves(scramble: readonly number[]): readonly ComiciTileMove[] {
  if (!parseComiciScramble(scramble)) throw new Error('Invalid Comici scramble');
  const sourceCells: Array<{ column: number; row: number }> = [];
  for (let column = 0; column < tileCount; column += 1) {
    for (let row = 0; row < tileCount; row += 1) {
      sourceCells.push({ column, row });
    }
  }
  return scramble.map((sourceIndex, destinationIndex) => ({
    sourceColumn: sourceCells[sourceIndex].column,
    sourceRow: sourceCells[sourceIndex].row,
    destinationColumn: Math.floor(destinationIndex / tileCount),
    destinationRow: destinationIndex % tileCount,
  }));
}

function canvasToBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) {
        reject(signal.reason);
      } else if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to export restored Comici page'));
      }
    }, 'image/png');
  });
}

export async function restoreComiciPageImage(
  rawImage: Blob,
  page: ComiciPageDescriptor,
  signal: AbortSignal,
  document: Document = globalThis.document,
): Promise<File> {
  if (signal.aborted) throw signal.reason;
  const bitmap = await createImageBitmap(rawImage);
  try {
    if (signal.aborted) throw signal.reason;
    const width = bitmap.width - (bitmap.width % tileCount);
    const height = bitmap.height - (bitmap.height % tileCount);
    if (width <= 0 || height <= 0) throw new Error('Invalid Comici source image dimensions');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    const tileWidth = width / tileCount;
    const tileHeight = height / tileCount;
    for (const move of createComiciTileMoves(page.scramble)) {
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
    const restored = await canvasToBlob(canvas, signal);
    return new File([restored], `comici-page-${page.pageIndex + 1}.png`, { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

export async function acquireComiciPageFile(
  pageIndex: number,
  manifestClient: ComiciManifestClient,
  downloadImage: DownloadImageForTranslation,
  restoreImage: typeof restoreComiciPageImage,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<File> {
  let manifest = await manifestClient.loadComplete(signal);
  let page = manifest.pages[pageIndex];
  if (!page) throw new Error(`Comici page ${pageIndex + 1} is unavailable`);
  if (page.expiresOn - signedUrlExpiryBufferMs <= now()) {
    manifest = await manifestClient.loadComplete(signal, true);
    page = manifest.pages[pageIndex];
    if (!page) throw new Error(`Comici page ${pageIndex + 1} is unavailable`);
  }

  let downloaded;
  try {
    downloaded = await downloadImage(
      { kind: 'remote-image', url: page.imageUrl, referrerPolicy: 'strict-origin-when-cross-origin' },
      { signal },
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    manifest = await manifestClient.loadComplete(signal, true);
    page = manifest.pages[pageIndex];
    if (!page) throw error;
    downloaded = await downloadImage(
      { kind: 'remote-image', url: page.imageUrl, referrerPolicy: 'strict-origin-when-cross-origin' },
      { signal },
    );
  }
  return restoreImage(downloaded.blob, page, signal);
}
