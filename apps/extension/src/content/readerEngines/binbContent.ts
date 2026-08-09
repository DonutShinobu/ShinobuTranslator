import type { DownloadImageForTranslation } from '../core/translation/imageTranslationExecution';
import {
  isUrlWithinRestrictedResourceBase,
  parseCredentiallessHttpsUrl,
  parseRestrictedResourceBaseUrl,
} from '../../shared/restrictedResourceUrl';
import { restoreBinbPageImage } from './binbDescrambler';
import { BinbInvalidResponseError, BinbUnsupportedError } from './binbErrors';

export { createBinbDescramblePlan, restoreBinbPageImage } from './binbDescrambler';
export type { BinbDescramblePlan, BinbTileMove } from './binbDescrambler';
export { BinbInvalidResponseError, BinbUnsupportedError } from './binbErrors';

export type BinbServerType = 0 | 1 | 2;
export type BinbViewMode = 1 | 2 | 3;
export type BinbImageQuality = 'low' | 'high';

export type BinbResourceRequest = {
  url: string;
  /** HTTPS origin and base path that the request and final response must remain under. */
  allowedBaseUrl: string;
};

export type BinbResourceResponse = {
  text: string;
  contentType: string;
  sourceUrl: string;
};

export type BinbResourceFetcher = (
  request: BinbResourceRequest,
  options?: { signal?: AbortSignal },
) => Promise<BinbResourceResponse>;

export type BinbPageDescriptor = {
  pageIndex: number;
  src: string;
  width: number;
  height: number;
  scrambleSourceKey: string;
  scrambleDestinationKey: string;
};

export type BinbScrambleTables = {
  stbl: readonly number[];
  ttbl: readonly number[];
  ptbl: readonly string[];
  ctbl: readonly string[];
};

export type BinbManifest = {
  cid: string;
  serverType: BinbServerType;
  viewMode: BinbViewMode;
  contentBaseUrl: string;
  requestToken?: string;
  contentDate?: string;
  imageClass: 'singlequality' | 'multiquality';
  readerUrl: string;
  scrambleTables: BinbScrambleTables;
  pages: readonly BinbPageDescriptor[];
};

export type BinbContentClient = {
  read(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<BinbManifest>;
};

export type BinbImageRequest = {
  url: string;
  allowedBaseUrl: string;
};

const keyAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const maxManifestPages = 2_000;
const maxImageDimension = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseHttpsUrl(value: string, label: string): URL {
  const parsed = parseCredentiallessHttpsUrl(value);
  if (!parsed) {
    throw new BinbInvalidResponseError(`${label}必须是无凭据的 HTTPS URL`);
  }
  return parsed;
}

export function normalizeBinbBaseUrl(value: string): string {
  const parsed = parseRestrictedResourceBaseUrl(value);
  if (!parsed) {
    throw new BinbInvalidResponseError('BinB 内容服务器必须是无凭据、无查询参数的 HTTPS URL');
  }
  return parsed.href;
}

export function isBinbUrlWithinBase(url: string, allowedBaseUrl: string): boolean {
  const target = parseCredentiallessHttpsUrl(url);
  const base = parseRestrictedResourceBaseUrl(allowedBaseUrl);
  return Boolean(target && base && isUrlWithinRestrictedResourceBase(target, base));
}

function assertResourceResponse(
  response: BinbResourceResponse,
  request: BinbResourceRequest,
): void {
  if (!isBinbUrlWithinBase(response.sourceUrl, request.allowedBaseUrl)) {
    throw new BinbInvalidResponseError('BinB 资源响应离开了声明的内容服务器路径');
  }
}

function resolveUnderBase(baseUrl: string, relativePath: string): URL {
  if (
    !relativePath
    || relativePath.startsWith('/')
    || relativePath.startsWith('\\')
    || relativePath.includes('\\')
    || /^[a-z][a-z\d+.-]*:/iu.test(relativePath)
  ) {
    throw new BinbInvalidResponseError('BinB 图片地址不是安全的相对路径');
  }
  const resolved = new URL(relativePath, baseUrl);
  if (!isBinbUrlWithinBase(resolved.href, baseUrl)) {
    throw new BinbInvalidResponseError('BinB 图片地址离开了声明的内容服务器路径');
  }
  return resolved;
}

function copyKeyParameters(source: URL, destination: URL): void {
  for (let index = 0; index <= 9; index += 1) {
    const name = `u${index}`;
    const value = source.searchParams.get(name);
    if (value !== null) destination.searchParams.set(name, value);
  }
}

export function generateBinbSharedKey(
  cid: string,
  randomBlock: () => string = () => Array.from(
    { length: 16 },
    () => keyAlphabet[Math.floor(Math.random() * keyAlphabet.length)],
  ).join(''),
): string {
  if (!cid) throw new BinbInvalidResponseError('BinB ContentID 为空');
  const random = randomBlock();
  if (random.length !== 16 || [...random].some((character) => !keyAlphabet.includes(character))) {
    throw new BinbInvalidResponseError('BinB 随机密钥块无效');
  }
  const repeated = cid.repeat(Math.ceil(16 / cid.length));
  const first = repeated.slice(0, 16);
  const last = repeated.slice(-16);
  let randomXor = 0;
  let firstXor = 0;
  let lastXor = 0;
  let sharedKey = '';
  for (let index = 0; index < random.length; index += 1) {
    randomXor ^= random.charCodeAt(index);
    firstXor ^= first.charCodeAt(index);
    lastXor ^= last.charCodeAt(index);
    sharedKey += random[index];
    sharedKey += keyAlphabet[(randomXor + firstXor + lastXor) & 63];
  }
  return sharedKey;
}

export function decodeBinbTable(cid: string, sharedKey: string, table: string): unknown {
  const seedSource = `${cid}:${sharedKey}`;
  let seed = [...seedSource].reduce(
    (sum, character, index) => sum + (character.charCodeAt(0) << (index % 16)),
    0,
  ) & 0x7fffffff;
  if (seed === 0) seed = 0x12345678;
  let decoded = '';
  for (const character of table) {
    seed = (seed >>> 1) ^ (1210056708 & -(seed & 1));
    decoded += String.fromCharCode((character.charCodeAt(0) - 32 + seed) % 94 + 32);
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new BinbInvalidResponseError('BinB 加密表解码失败');
  }
}

function parseNumberTable(value: unknown, label: string): readonly number[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 10_000
    || value.some((item) => !Number.isSafeInteger(item))
  ) {
    throw new BinbInvalidResponseError(`BinB ${label} 表无效`);
  }
  return value as number[];
}

function parseStringTable(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 8
    || value.length > 64
    || value.some((item) => typeof item !== 'string' || !item || item.length > 10_000)
  ) {
    throw new BinbInvalidResponseError(`BinB ${label} 表无效`);
  }
  return value as string[];
}

function parseServerType(value: unknown): BinbServerType {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new BinbUnsupportedError(`未知 ServerType ${String(value)}`);
}

function parseViewMode(value: unknown): BinbViewMode {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new BinbUnsupportedError(`未知 ViewMode ${String(value)}`);
}

function parseContentItem(value: unknown, expectedCid: string, sharedKey: string) {
  if (!isRecord(value) || typeof value.ContentID !== 'string' || !value.ContentID) {
    throw new BinbInvalidResponseError('BinB 内容信息缺少规范 ContentID');
  }
  const serverType = parseServerType(value.ServerType);
  const viewMode = parseViewMode(value.ViewMode);
  if (
    typeof value.ContentsServer !== 'string'
    || typeof value.stbl !== 'string'
    || typeof value.ttbl !== 'string'
    || typeof value.ptbl !== 'string'
    || typeof value.ctbl !== 'string'
  ) {
    throw new BinbInvalidResponseError('BinB 内容信息缺少必要字段');
  }
  const requestToken = value.p === undefined || value.p === null
    ? undefined
    : typeof value.p === 'string' && value.p
      ? value.p
      : null;
  const contentDate = value.ContentDate === undefined || value.ContentDate === null
    ? undefined
    : typeof value.ContentDate === 'string' && value.ContentDate
      ? value.ContentDate
      : null;
  if (requestToken === null || contentDate === null) {
    throw new BinbInvalidResponseError('BinB 内容令牌或日期无效');
  }
  return {
    serverType,
    viewMode,
    contentBaseUrl: normalizeBinbBaseUrl(value.ContentsServer),
    ...(requestToken ? { requestToken } : {}),
    ...(contentDate ? { contentDate } : {}),
    scrambleTables: {
      stbl: parseNumberTable(decodeBinbTable(expectedCid, sharedKey, value.stbl), 'stbl'),
      ttbl: parseNumberTable(decodeBinbTable(expectedCid, sharedKey, value.ttbl), 'ttbl'),
      ptbl: parseStringTable(decodeBinbTable(expectedCid, sharedKey, value.ptbl), 'ptbl'),
      ctbl: parseStringTable(decodeBinbTable(expectedCid, sharedKey, value.ctbl), 'ctbl'),
    },
  };
}

function parseMetadata(text: string, expectedCid: string, sharedKey: string) {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new BinbInvalidResponseError('BinB 内容信息不是有效 JSON');
  }
  if (!isRecord(value) || value.result !== 1 || !Array.isArray(value.items) || value.items.length === 0) {
    throw new BinbInvalidResponseError('BinB 内容信息请求失败或没有条目');
  }
  return parseContentItem(value.items[0], expectedCid, sharedKey);
}

function parseJsonContentPayload(json: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new BinbInvalidResponseError('BinB 内容清单不是有效 JSON');
  }
  if (!isRecord(value) || value.result !== 1 || typeof value.ttx !== 'string') {
    throw new BinbInvalidResponseError('BinB 内容清单请求失败或缺少 TTX');
  }
  return value;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeXmlAttribute(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function parsePositiveDimension(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maxImageDimension
    ? parsed
    : null;
}

function selectScrambleKeys(
  src: string,
  tables: Pick<BinbScrambleTables, 'ptbl' | 'ctbl'>,
): { scrambleSourceKey: string; scrambleDestinationKey: string } {
  const filename = src.slice(src.lastIndexOf('/') + 1);
  const indexes = [0, 0];
  for (let index = 0; index < filename.length; index += 1) {
    indexes[index % 2] += filename.charCodeAt(index);
  }
  const source = tables.ptbl[indexes[0] % 8];
  const destination = tables.ctbl[indexes[1] % 8];
  if (!source || !destination) {
    throw new BinbInvalidResponseError('BinB 图片拼图表缺少对应条目');
  }
  return { scrambleSourceKey: source, scrambleDestinationKey: destination };
}

export function parseBinbTtxPages(
  ttx: string,
  tables: Pick<BinbScrambleTables, 'ptbl' | 'ctbl'>,
): readonly BinbPageDescriptor[] {
  const firstCase = /<t-case\b[^>]*>([\s\S]*?)<\/t-case\s*>/iu.exec(ttx)?.[1];
  if (!firstCase) throw new BinbUnsupportedError('TTX 没有固定版式 t-case');
  const seen = new Set<string>();
  const pages: BinbPageDescriptor[] = [];
  for (const match of firstCase.matchAll(/<t-img\b([^>]*)\/?\s*>/giu)) {
    const attributes = parseAttributes(match[1]);
    const src = attributes.src;
    const width = parsePositiveDimension(attributes.orgwidth);
    const height = parsePositiveDimension(attributes.orgheight);
    if (!src || !width || !height || width * height > 100_000_000) {
      throw new BinbInvalidResponseError('BinB TTX 图片描述无效');
    }
    const physicalKey = `${src}\u0000${width}\u0000${height}`;
    if (seen.has(physicalKey)) continue;
    seen.add(physicalKey);
    pages.push({
      pageIndex: pages.length,
      src,
      width,
      height,
      ...selectScrambleKeys(src, tables),
    });
    if (pages.length > maxManifestPages) {
      throw new BinbInvalidResponseError('BinB TTX 页数超过安全上限');
    }
  }
  if (pages.length === 0) throw new BinbUnsupportedError('TTX 没有固定版式图片页');
  return pages;
}

type ParsedContentItem = ReturnType<typeof parseContentItem>;

type BinbBackendLoader = {
  readonly serverType: BinbServerType;
  createContentRequest(
    item: ParsedContentItem,
    cid: string,
    readerUrl: URL,
    now: number,
  ): BinbResourceRequest;
  parseContentPayload(text: string): Record<string, unknown>;
  buildImageRequest(
    manifest: BinbManifest,
    page: BinbPageDescriptor,
    quality: BinbImageQuality,
  ): BinbImageRequest;
  identifyImageQuality(manifest: BinbManifest, resourceUrl: URL): BinbImageQuality | null;
};

const sbcBackendLoader: BinbBackendLoader = {
  serverType: 0,
  createContentRequest(item, cid, readerUrl, now) {
    const url = resolveUnderBase(item.contentBaseUrl, 'sbcGetCntnt.php');
    url.searchParams.set('cid', cid);
    if (item.requestToken) url.searchParams.set('p', item.requestToken);
    url.searchParams.set('q', '1');
    url.searchParams.set('vm', String(item.viewMode));
    url.searchParams.set('dmytime', item.contentDate ?? String(now));
    copyKeyParameters(readerUrl, url);
    return { url: url.href, allowedBaseUrl: item.contentBaseUrl };
  },
  parseContentPayload: parseJsonContentPayload,
  buildImageRequest(manifest, page, quality) {
    const url = resolveUnderBase(manifest.contentBaseUrl, 'sbcGetImg.php');
    url.searchParams.set('cid', manifest.cid);
    url.searchParams.set('src', page.src);
    if (manifest.requestToken) url.searchParams.set('p', manifest.requestToken);
    if (manifest.imageClass !== 'singlequality') {
      const trial = manifest.viewMode === 2 || manifest.viewMode === 3;
      url.searchParams.set('q', quality === 'high' && !trial ? '0' : '1');
    }
    url.searchParams.set('vm', String(manifest.viewMode));
    if (manifest.contentDate) url.searchParams.set('dmytime', manifest.contentDate);
    copyKeyParameters(new URL(manifest.readerUrl), url);
    return { url: url.href, allowedBaseUrl: manifest.contentBaseUrl };
  },
  identifyImageQuality(manifest, resourceUrl) {
    const endpoint = resolveUnderBase(manifest.contentBaseUrl, 'sbcGetImg.php');
    if (
      resourceUrl.pathname !== endpoint.pathname
      || resourceUrl.searchParams.get('cid') !== manifest.cid
    ) return null;
    const quality = resourceUrl.searchParams.get('q');
    return quality === '0' ? 'high' : quality === '1' ? 'low' : null;
  },
};

const directBackendLoader: BinbBackendLoader = {
  serverType: 1,
  createContentRequest(item) {
    const url = resolveUnderBase(item.contentBaseUrl, 'content.js');
    if (item.contentDate) url.searchParams.set('dmytime', item.contentDate);
    return { url: url.href, allowedBaseUrl: item.contentBaseUrl };
  },
  parseContentPayload(text) {
    const match = /^\s*DataGet_Content\(([\s\S]*)\)\s*;?\s*$/u.exec(text);
    if (!match) throw new BinbInvalidResponseError('BinB Direct 内容包装格式无效');
    return parseJsonContentPayload(match[1]);
  },
  buildImageRequest(manifest, page, quality) {
    const filename = manifest.imageClass === 'singlequality'
      ? 'M.jpg'
      : quality === 'high'
        ? 'M_H.jpg'
        : 'M_L.jpg';
    const url = resolveUnderBase(manifest.contentBaseUrl, `${page.src}/${filename}`);
    if (manifest.contentDate) url.searchParams.set('dmytime', manifest.contentDate);
    return { url: url.href, allowedBaseUrl: manifest.contentBaseUrl };
  },
  identifyImageQuality(_manifest, resourceUrl) {
    if (/\/M_H\.jpg$/iu.test(resourceUrl.pathname)) return 'high';
    if (/\/M_L\.jpg$/iu.test(resourceUrl.pathname)) return 'low';
    return null;
  },
};

const restBackendLoader: BinbBackendLoader = {
  serverType: 2,
  createContentRequest(item) {
    const url = resolveUnderBase(item.contentBaseUrl, 'content');
    return { url: url.href, allowedBaseUrl: item.contentBaseUrl };
  },
  parseContentPayload: parseJsonContentPayload,
  buildImageRequest(manifest, page, quality) {
    const url = resolveUnderBase(manifest.contentBaseUrl, `img/${page.src}`);
    if (manifest.imageClass !== 'singlequality' && quality === 'low') {
      url.searchParams.set('q', '1');
    }
    if (manifest.contentDate) url.searchParams.set('dmytime', manifest.contentDate);
    copyKeyParameters(new URL(manifest.readerUrl), url);
    return { url: url.href, allowedBaseUrl: manifest.contentBaseUrl };
  },
  identifyImageQuality(manifest, resourceUrl) {
    const base = new URL(manifest.contentBaseUrl);
    if (!resourceUrl.pathname.startsWith(`${base.pathname}img/`)) return null;
    return resourceUrl.searchParams.get('q') === '1' ? 'low' : 'high';
  },
};

const backendLoaders: Record<BinbServerType, BinbBackendLoader> = {
  0: sbcBackendLoader,
  1: directBackendLoader,
  2: restBackendLoader,
};

function getBackendLoader(serverType: BinbServerType): BinbBackendLoader {
  return backendLoaders[serverType];
}

export function buildBinbImageRequest(
  manifest: BinbManifest,
  page: BinbPageDescriptor,
  quality: BinbImageQuality,
): BinbImageRequest {
  return getBackendLoader(manifest.serverType).buildImageRequest(manifest, page, quality);
}

export function identifyBinbImageQuality(
  manifest: BinbManifest,
  resourceUrl: string,
): BinbImageQuality | null {
  if (!isBinbUrlWithinBase(resourceUrl, manifest.contentBaseUrl)) return null;
  const parsed = parseCredentiallessHttpsUrl(resourceUrl);
  return parsed
    ? getBackendLoader(manifest.serverType).identifyImageQuality(manifest, parsed)
    : null;
}

export function createBinbContextKey(cid: string, readerUrl: string): string {
  const parsed = parseHttpsUrl(readerUrl, 'BinB 阅读器地址');
  return ['binb', cid, `${parsed.origin}${parsed.pathname}`].join(':');
}

function readManifestPage(
  manifest: BinbManifest,
  pageIndex: number,
  expectedContextKey: string,
): BinbPageDescriptor {
  if (createBinbContextKey(manifest.cid, manifest.readerUrl) !== expectedContextKey) {
    throw new Error('BinB 阅读上下文已变化');
  }
  const page = manifest.pages[pageIndex];
  if (!page) throw new Error(`BinB 第 ${pageIndex + 1} 页不存在`);
  return page;
}

export async function acquireBinbPageFile(
  pageIndex: number,
  expectedContextKey: string,
  client: BinbContentClient,
  quality: BinbImageQuality,
  downloadImage: DownloadImageForTranslation,
  restoreImage: typeof restoreBinbPageImage,
  signal: AbortSignal,
): Promise<File> {
  let manifest: BinbManifest;
  try {
    manifest = await client.read({ signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BinbUnsupportedError) throw error;
    manifest = await client.read({ forceRefresh: true, signal });
  }
  let page = readManifestPage(manifest, pageIndex, expectedContextKey);
  const download = (currentManifest: BinbManifest, currentPage: BinbPageDescriptor) => {
    const request = buildBinbImageRequest(currentManifest, currentPage, quality);
    return downloadImage(
      {
        kind: 'remote-image',
        url: request.url,
        allowedBaseUrl: request.allowedBaseUrl,
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      { signal },
    );
  };

  let downloaded;
  try {
    downloaded = await download(manifest, page);
  } catch (originalError) {
    if (signal.aborted) throw signal.reason;
    manifest = await client.read({ forceRefresh: true, signal });
    page = readManifestPage(manifest, pageIndex, expectedContextKey);
    try {
      downloaded = await download(manifest, page);
    } catch {
      throw originalError;
    }
  }
  return restoreImage(downloaded.blob, page, signal);
}

export function createBinbContentClient(options: {
  cid: string;
  metadataUrl: string;
  readerUrl: string;
  fetchResource: BinbResourceFetcher;
  randomBlock?: () => string;
  now?: () => number;
}): BinbContentClient {
  const readerUrl = parseHttpsUrl(options.readerUrl, 'BinB 阅读器地址');
  const metadataEndpoint = parseHttpsUrl(options.metadataUrl, 'BinB 内容信息地址');
  if (metadataEndpoint.origin !== readerUrl.origin) {
    throw new BinbInvalidResponseError('BinB 内容信息地址必须与阅读器同源');
  }
  const metadataBaseUrl = `${metadataEndpoint.origin}/`;
  let cached: Promise<BinbManifest> | null = null;

  const load = async (signal?: AbortSignal): Promise<BinbManifest> => {
    const sharedKey = generateBinbSharedKey(options.cid, options.randomBlock);
    const metadataUrl = new URL(metadataEndpoint.href);
    metadataUrl.searchParams.set('cid', options.cid);
    metadataUrl.searchParams.set('k', sharedKey);
    metadataUrl.searchParams.set('dmytime', String((options.now ?? Date.now)()));
    copyKeyParameters(readerUrl, metadataUrl);
    const metadataRequest = { url: metadataUrl.href, allowedBaseUrl: metadataBaseUrl };
    const metadataResponse = await options.fetchResource(metadataRequest, { signal });
    assertResourceResponse(metadataResponse, metadataRequest);
    const item = parseMetadata(metadataResponse.text, options.cid, sharedKey);
    const backendLoader = getBackendLoader(item.serverType);
    const contentRequest = backendLoader.createContentRequest(
      item,
      options.cid,
      readerUrl,
      (options.now ?? Date.now)(),
    );
    const contentResponse = await options.fetchResource(contentRequest, { signal });
    assertResourceResponse(contentResponse, contentRequest);
    const content = backendLoader.parseContentPayload(contentResponse.text);
    const imageClass = content.ImageClass === 'singlequality'
      ? 'singlequality'
      : content.ImageClass === undefined
        || content.ImageClass === null
        || content.ImageClass === 'default'
        || content.ImageClass === 'multiquality'
        ? 'multiquality'
        : null;
    if (!imageClass) throw new BinbUnsupportedError(`未知 ImageClass ${String(content.ImageClass)}`);
    return {
      cid: options.cid,
      serverType: item.serverType,
      viewMode: item.viewMode,
      contentBaseUrl: item.contentBaseUrl,
      ...(item.requestToken ? { requestToken: item.requestToken } : {}),
      ...(item.contentDate ? { contentDate: item.contentDate } : {}),
      imageClass,
      readerUrl: readerUrl.href,
      scrambleTables: item.scrambleTables,
      pages: parseBinbTtxPages(content.ttx as string, item.scrambleTables),
    };
  };

  return {
    read({ forceRefresh = false, signal } = {}) {
      if (forceRefresh) cached = null;
      cached ??= load(signal).catch((error) => {
        cached = null;
        throw error;
      });
      return cached;
    },
  };
}
