import type { DownloadImageForTranslation } from '../core/translation/imageTranslationExecution';
import {
  createPublusV1ImagePath,
  createPublusV1TileMoves,
  decodePublusV1Pack,
  type PublusV1Keys,
  type PublusV1PageParameters,
} from './publusReaderV1';

const defaultPageLimit = 200;
const maximumImageDimension = 20_000;
const maximumImageArea = 100_000_000;
const allowedAuthKeys = [
  'pfCd',
  'hti',
  'bid',
  'uuid',
  'Policy',
  'Signature',
  'Key-Pair-Id',
] as const;

export class PublusReaderInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublusReaderInvalidResponseError';
  }
}

export class PublusReaderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublusReaderUnsupportedError';
  }
}

export type PublusObservedSession = {
  viewerUrl: string;
  contentCheckUrl: string;
  configurationUrl: string;
  protocolMajor: 1 | 2;
};

export type PublusReaderResourceRequest = {
  url: string;
  allowedBaseUrl: string;
};

export type PublusReaderResourceResponse = {
  text: string;
  contentType: string;
  sourceUrl: string;
};

export type PublusReaderResourceFetcher = (
  request: PublusReaderResourceRequest,
  options?: { signal?: AbortSignal },
) => Promise<PublusReaderResourceResponse>;

type PublusReadingDirection = 'rtl' | 'ltr';

export type PublusPageDescriptor = {
  pageIndex: number;
  width: number;
  height: number;
  request: PublusReaderResourceRequest;
  restoration:
    | { kind: 'none' }
    | { kind: 'publus-v1'; page: PublusV1PageParameters; keys: PublusV1Keys };
};

export type PublusReaderManifest = {
  profile: 'v1-packed' | 'v2-plain';
  pageCount: number;
  direction: PublusReadingDirection;
  pages: readonly PublusPageDescriptor[];
};

export type RestorePublusV1Image = (
  blob: Blob,
  page: PublusV1PageParameters,
  keys: PublusV1Keys,
  document: Document,
  signal: AbortSignal,
) => Promise<File>;

export type PublusReaderContentClient = {
  read(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<PublusReaderManifest>;
  acquirePublusPageFile(pageIndex: number, signal: AbortSignal): Promise<File>;
};

export type PublusContentClientOptions = {
  readObservedSession: () => PublusObservedSession | null;
  fetchResource: PublusReaderResourceFetcher;
  downloadImage: DownloadImageForTranslation;
  document: Document;
  restoreImage?: RestorePublusV1Image;
  pageLimit?: number;
};

type ContentAuthorization = {
  contentBaseUrl: string;
  configurationUrl: string;
  pageCount: number | null;
  contentType: number;
  query: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublusReaderInvalidResponseError(`${label}不是有效 URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new PublusReaderInvalidResponseError(`${label}必须是无凭据 HTTPS URL`);
  }
  return parsed;
}

function directoryBase(url: URL): string {
  const slash = url.pathname.lastIndexOf('/');
  const pathname = slash < 0 ? '/' : url.pathname.slice(0, slash + 1);
  return `${url.origin}${pathname}`;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublusReaderInvalidResponseError(`${label}不是有效 JSON`);
  }
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PublusReaderInvalidResponseError('PUBLUS lp 无效');
  }
  return parsed;
}

function appendAuthorizationQuery(url: URL, authInfo: unknown): string {
  if (authInfo === undefined || authInfo === null) return url.href;
  if (!isRecord(authInfo)) {
    throw new PublusReaderInvalidResponseError('PUBLUS auth_info 无效');
  }
  for (const key of allowedAuthKeys) {
    const value = authInfo[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PublusReaderInvalidResponseError(`PUBLUS 授权字段 ${key} 无效`);
    }
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

function validateObservedSession(session: PublusObservedSession): {
  viewer: URL;
  contentCheck: URL;
  configuration: URL;
  observedBaseUrl: string;
} {
  const viewer = parseHttpsUrl(session.viewerUrl, 'PUBLUS viewer 地址');
  const contentCheck = parseHttpsUrl(session.contentCheckUrl, 'PUBLUS 许可地址');
  const configuration = parseHttpsUrl(session.configurationUrl, 'PUBLUS 配置地址');
  const cid = viewer.searchParams.get('cid');
  if (!cid || contentCheck.searchParams.get('cid') !== cid) {
    throw new PublusReaderInvalidResponseError('PUBLUS 许可请求与当前 cid 不一致');
  }
  if (!/\/configuration_pack\.json$/u.test(configuration.pathname)) {
    throw new PublusReaderInvalidResponseError('PUBLUS 配置请求不是 configuration_pack.json');
  }
  return {
    viewer,
    contentCheck,
    configuration,
    observedBaseUrl: directoryBase(configuration),
  };
}

async function readAuthorization(
  session: PublusObservedSession,
  fetchResource: PublusReaderResourceFetcher,
  signal?: AbortSignal,
): Promise<ContentAuthorization> {
  const observed = validateObservedSession(session);
  const request = {
    url: observed.contentCheck.href,
    allowedBaseUrl: directoryBase(observed.contentCheck),
  };
  const response = await fetchResource(request, { signal });
  if (response.sourceUrl !== request.url) {
    throw new PublusReaderInvalidResponseError('PUBLUS 许可请求发生重定向');
  }
  const value = parseJson(response.text, 'PUBLUS 许可响应');
  if (!isRecord(value)) {
    throw new PublusReaderInvalidResponseError('PUBLUS 许可响应结构无效');
  }
  if (Number(value.status) !== 200) throw new Error('PUBLUS 当前会话许可失败');
  if (typeof value.url !== 'string') {
    throw new PublusReaderInvalidResponseError('PUBLUS 许可响应缺少内容基址');
  }
  const contentBase = parseHttpsUrl(value.url, 'PUBLUS 内容基址');
  if (!contentBase.pathname.endsWith('/')) contentBase.pathname += '/';
  contentBase.search = '';
  contentBase.hash = '';
  if (contentBase.href !== observed.observedBaseUrl) {
    throw new PublusReaderInvalidResponseError('PUBLUS 内容基址与已观察配置目录不一致');
  }
  const contentType = Number(value.cty);
  if (contentType !== 1) {
    throw new PublusReaderUnsupportedError(`仅支持固定版式 cty=1，当前为 ${String(value.cty)}`);
  }
  const configuration = new URL('configuration_pack.json', contentBase);
  const configurationUrl = appendAuthorizationQuery(configuration, value.auth_info);
  return {
    contentBaseUrl: contentBase.href,
    configurationUrl,
    pageCount: parseOptionalPositiveInteger(value.lp),
    contentType,
    query: new URL(configurationUrl).search,
  };
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximumImageDimension
  ) {
    throw new PublusReaderInvalidResponseError(`${label}无效`);
  }
  return value;
}

function safeContentPath(value: unknown): string {
  let decoded = '';
  if (typeof value === 'string') {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = '';
    }
  }
  if (
    typeof value !== 'string'
    || !value
    || !decoded
    || decoded.startsWith('/')
    || decoded.includes('\\')
    || decoded.includes('?')
    || decoded.includes('#')
    || decoded.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new PublusReaderInvalidResponseError('PUBLUS content file 路径无效');
  }
  return value;
}

function isWithinContentBase(url: URL, contentBaseUrl: string): boolean {
  const base = new URL(contentBaseUrl);
  return url.origin === base.origin && url.pathname.startsWith(base.pathname);
}

function parsePlainManifest(
  value: unknown,
  authorization: ContentAuthorization,
  pageLimit: number,
): PublusReaderManifest {
  if (!isRecord(value) || !isRecord(value.configuration)) {
    throw new PublusReaderInvalidResponseError('PUBLUS 配置根节点无效');
  }
  const configuration = value.configuration;
  const direction = configuration['page-progression-direction'];
  if (direction !== 'rtl' && direction !== 'ltr') {
    throw new PublusReaderUnsupportedError(`不支持阅读方向 ${String(direction)}`);
  }
  if (!Array.isArray(configuration.contents) || configuration.contents.length === 0) {
    throw new PublusReaderInvalidResponseError('PUBLUS configuration.contents 缺失');
  }
  if (configuration.contents.length > pageLimit) {
    throw new PublusReaderUnsupportedError(
      `页数 ${configuration.contents.length} 超过上限 ${pageLimit}`,
    );
  }
  if (authorization.pageCount !== null && authorization.pageCount !== configuration.contents.length) {
    throw new PublusReaderInvalidResponseError('PUBLUS lp 与目录页数不一致');
  }
  const seenFiles = new Set<string>();
  const pages = configuration.contents.map((entry, pageIndex): PublusPageDescriptor => {
    if (!isRecord(entry)) throw new PublusReaderInvalidResponseError('PUBLUS content 条目无效');
    if (entry.index !== pageIndex + 1) {
      throw new PublusReaderInvalidResponseError('PUBLUS content index 不连续');
    }
    const file = safeContentPath(entry.file);
    if (seenFiles.has(file)) throw new PublusReaderInvalidResponseError('PUBLUS content file 重复');
    seenFiles.add(file);
    const imageType = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (!['jpeg', 'jpg', 'png'].includes(imageType)) {
      throw new PublusReaderUnsupportedError(`不支持图片类型 ${String(entry.type)}`);
    }
    const pageContainer = value[file];
    if (!isRecord(pageContainer) || !isRecord(pageContainer.FileLinkInfo)) {
      throw new PublusReaderInvalidResponseError('PUBLUS 页面链接信息缺失');
    }
    const links = pageContainer.FileLinkInfo.PageLinkInfoList;
    if (!Array.isArray(links) || links.length !== 1 || !isRecord(links[0]) || !isRecord(links[0].Page)) {
      throw new PublusReaderUnsupportedError('仅支持每个目录项对应一个固定布局页面');
    }
    const page = links[0].Page;
    if (!isRecord(page.Size)) throw new PublusReaderInvalidResponseError('PUBLUS Page.Size 缺失');
    const width = requiredPositiveInteger(page.Size.Width, 'PUBLUS 页面宽度');
    const height = requiredPositiveInteger(page.Size.Height, 'PUBLUS 页面高度');
    if (width * height > maximumImageArea) {
      throw new PublusReaderInvalidResponseError('PUBLUS 页面像素数超过上限');
    }
    const pageNumber = page.No;
    if (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber) || pageNumber < 0) {
      throw new PublusReaderInvalidResponseError('PUBLUS Page.No 无效');
    }
    const image = new URL(`${file}/${pageNumber}.${imageType}`, authorization.contentBaseUrl);
    if (!isWithinContentBase(image, authorization.contentBaseUrl)) {
      throw new PublusReaderInvalidResponseError('PUBLUS 图片地址超出内容目录');
    }
    image.search = authorization.query;
    return {
      pageIndex,
      width,
      height,
      request: {
        url: image.href,
        allowedBaseUrl: authorization.contentBaseUrl,
      },
      restoration: { kind: 'none' },
    };
  });
  return {
    profile: 'v2-plain',
    pageCount: pages.length,
    direction,
    pages,
  };
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximumImageDimension
  ) {
    throw new PublusReaderInvalidResponseError(`${label}无效`);
  }
  return value;
}

function requiredUint32(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 0xffff_ffff
  ) {
    throw new PublusReaderInvalidResponseError(`${label}无效`);
  }
  return value;
}

export function parsePublusV1Manifest(
  value: unknown,
  keys: PublusV1Keys,
  authorization: Pick<ContentAuthorization, 'contentBaseUrl' | 'pageCount' | 'query'>,
  pageLimit = defaultPageLimit,
): PublusReaderManifest {
  if (!isRecord(value) || !isRecord(value.configuration)) {
    throw new PublusReaderInvalidResponseError('PUBLUS 1.x 配置根节点无效');
  }
  const configuration = value.configuration;
  if (configuration['file-name-version'] !== '1.0') {
    throw new PublusReaderUnsupportedError('不支持 PUBLUS 1.x 文件名 profile');
  }
  const direction = configuration['page-progression-direction'];
  if (direction !== 'rtl' && direction !== 'ltr') {
    throw new PublusReaderUnsupportedError(`不支持阅读方向 ${String(direction)}`);
  }
  if (!Array.isArray(configuration.contents) || configuration.contents.length === 0) {
    throw new PublusReaderInvalidResponseError('PUBLUS configuration.contents 缺失');
  }
  if (configuration.contents.length > pageLimit) {
    throw new PublusReaderUnsupportedError(
      `页数 ${configuration.contents.length} 超过上限 ${pageLimit}`,
    );
  }
  if (authorization.pageCount !== null && authorization.pageCount !== configuration.contents.length) {
    throw new PublusReaderInvalidResponseError('PUBLUS lp 与目录页数不一致');
  }
  if (keys.some((key) => key.length !== 32)) {
    throw new PublusReaderInvalidResponseError('PUBLUS 1.x 书籍密钥长度无效');
  }
  const seenFiles = new Set<string>();
  const pages = configuration.contents.map((entry, pageIndex): PublusPageDescriptor => {
    if (!isRecord(entry)) throw new PublusReaderInvalidResponseError('PUBLUS content 条目无效');
    if (entry.index !== pageIndex + 1) {
      throw new PublusReaderInvalidResponseError('PUBLUS content index 不连续');
    }
    const file = safeContentPath(entry.file);
    if (seenFiles.has(file)) throw new PublusReaderInvalidResponseError('PUBLUS content file 重复');
    seenFiles.add(file);
    const imageType = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    if (!['jpeg', 'jpg', 'png'].includes(imageType)) {
      throw new PublusReaderUnsupportedError(`不支持图片类型 ${String(entry.type)}`);
    }
    const pageContainer = value[file];
    if (!isRecord(pageContainer) || !isRecord(pageContainer.FileLinkInfo)) {
      throw new PublusReaderInvalidResponseError('PUBLUS 页面链接信息缺失');
    }
    const links = pageContainer.FileLinkInfo.PageLinkInfoList;
    if (!Array.isArray(links) || links.length !== 1 || !isRecord(links[0]) || !isRecord(links[0].Page)) {
      throw new PublusReaderUnsupportedError('仅支持每个目录项对应一个固定布局页面');
    }
    const source = links[0].Page;
    if (!isRecord(source.Size)) throw new PublusReaderInvalidResponseError('PUBLUS Page.Size 缺失');
    const width = requiredPositiveInteger(source.Size.Width, 'PUBLUS 页面宽度');
    const height = requiredPositiveInteger(source.Size.Height, 'PUBLUS 页面高度');
    const dummyWidth = requiredNonNegativeInteger(source.DummyWidth, 'PUBLUS DummyWidth');
    const dummyHeight = requiredNonNegativeInteger(source.DummyHeight, 'PUBLUS DummyHeight');
    const sourceWidth = width + dummyWidth;
    const sourceHeight = height + dummyHeight;
    if (
      sourceWidth > maximumImageDimension
      || sourceHeight > maximumImageDimension
      || sourceWidth * sourceHeight > maximumImageArea
    ) {
      throw new PublusReaderInvalidResponseError('PUBLUS 页面像素数超过上限');
    }
    const blockWidth = requiredPositiveInteger(source.BlockWidth, 'PUBLUS BlockWidth');
    const blockHeight = requiredPositiveInteger(source.BlockHeight, 'PUBLUS BlockHeight');
    if (blockWidth > sourceWidth || blockHeight > sourceHeight) {
      throw new PublusReaderUnsupportedError('PUBLUS 分块尺寸大于页面尺寸');
    }
    const pageNumber = requiredNonNegativeInteger(source.No, 'PUBLUS Page.No');
    const page: PublusV1PageParameters = {
      file,
      fileName: String(pageNumber),
      width,
      height,
      blockWidth,
      blockHeight,
      dummyWidth,
      dummyHeight,
      ns: requiredUint32(source.NS, 'PUBLUS NS'),
      ps: requiredUint32(source.PS, 'PUBLUS PS'),
      rs: requiredUint32(source.RS, 'PUBLUS RS'),
    };
    const image = new URL(
      createPublusV1ImagePath(file, page.fileName, imageType, keys),
      authorization.contentBaseUrl,
    );
    if (!isWithinContentBase(image, authorization.contentBaseUrl)) {
      throw new PublusReaderInvalidResponseError('PUBLUS 图片地址超出内容目录');
    }
    image.search = authorization.query;
    return {
      pageIndex,
      width,
      height,
      request: {
        url: image.href,
        allowedBaseUrl: authorization.contentBaseUrl,
      },
      restoration: { kind: 'publus-v1', page, keys },
    };
  });
  return {
    profile: 'v1-packed',
    pageCount: pages.length,
    direction,
    pages,
  };
}

function canvasToPngFile(
  canvas: HTMLCanvasElement,
  fileName: string,
  signal: AbortSignal,
): Promise<File> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) {
        reject(signal.reason);
      } else if (!blob) {
        reject(new Error('PUBLUS Canvas 导出失败'));
      } else {
        resolve(new File([blob], fileName, { type: 'image/png' }));
      }
    }, 'image/png');
  });
}

export async function restorePublusV1PageImage(
  blob: Blob,
  page: PublusV1PageParameters,
  keys: PublusV1Keys,
  document: Document,
  signal: AbortSignal,
): Promise<File> {
  if (signal.aborted) throw signal.reason;
  const bitmap = await createImageBitmap(blob);
  try {
    const expectedWidth = page.width + page.dummyWidth;
    const expectedHeight = page.height + page.dummyHeight;
    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
      throw new PublusReaderInvalidResponseError('PUBLUS 1.x 图片尺寸与配置不一致');
    }
    const decoded = document.createElement('canvas');
    decoded.width = bitmap.width;
    decoded.height = bitmap.height;
    const context = decoded.getContext('2d');
    if (!context) throw new Error('PUBLUS Canvas 2D 不可用');
    for (const move of createPublusV1TileMoves(page, keys)) {
      context.drawImage(
        bitmap,
        move.sourceX,
        move.sourceY,
        move.width,
        move.height,
        move.destinationX,
        move.destinationY,
        move.width,
        move.height,
      );
    }
    if (decoded.width === page.width && decoded.height === page.height) {
      return await canvasToPngFile(decoded, 'publus-page.png', signal);
    }
    const cropped = document.createElement('canvas');
    cropped.width = page.width;
    cropped.height = page.height;
    const croppedContext = cropped.getContext('2d');
    if (!croppedContext) throw new Error('PUBLUS 裁切 Canvas 2D 不可用');
    croppedContext.drawImage(
      decoded,
      0,
      0,
      page.width,
      page.height,
      0,
      0,
      page.width,
      page.height,
    );
    return await canvasToPngFile(cropped, 'publus-page.png', signal);
  } finally {
    bitmap.close();
  }
}

export function createPublusReaderContentClient(
  options: PublusContentClientOptions,
): PublusReaderContentClient {
  let manifestCache: Promise<PublusReaderManifest> | null = null;
  const pageLimit = Math.min(defaultPageLimit, options.pageLimit ?? defaultPageLimit);
  if (!Number.isSafeInteger(pageLimit) || pageLimit <= 0) {
    throw new PublusReaderInvalidResponseError('PUBLUS 页数上限无效');
  }

  const load = async (signal?: AbortSignal): Promise<PublusReaderManifest> => {
    if (signal?.aborted) throw signal.reason;
    const observed = options.readObservedSession();
    if (!observed) throw new PublusReaderInvalidResponseError('未观察到 PUBLUS 内容请求');
    const authorization = await readAuthorization(observed, options.fetchResource, signal);
    const request = {
      url: authorization.configurationUrl,
      allowedBaseUrl: authorization.contentBaseUrl,
    };
    const response = await options.fetchResource(request, { signal });
    if (response.sourceUrl !== request.url) {
      throw new PublusReaderInvalidResponseError('PUBLUS 配置请求发生重定向');
    }
    const parsed = parseJson(response.text, 'PUBLUS 配置');
    if (observed.protocolMajor === 1) {
      if (!isRecord(parsed) || typeof parsed.data !== 'string') {
        throw new PublusReaderUnsupportedError('PUBLUS 1.x 配置包结构未知');
      }
      if (parsed.version !== '1.0') {
        throw new PublusReaderUnsupportedError(`不支持 PUBLUS 配置版本 ${String(parsed.version)}`);
      }
      let decoded;
      try {
        decoded = decodePublusV1Pack(response.text);
      } catch (error) {
        throw new PublusReaderInvalidResponseError(
          error instanceof Error ? error.message : 'PUBLUS 1.x 配置解包失败',
        );
      }
      return parsePublusV1Manifest(
        decoded.configuration,
        decoded.keys,
        authorization,
        pageLimit,
      );
    }
    if (isRecord(parsed) && typeof parsed.data === 'string') {
      throw new PublusReaderUnsupportedError('PUBLUS 2.x 返回了未知封装配置');
    }
    return parsePlainManifest(parsed, authorization, pageLimit);
  };

  return {
    read({ forceRefresh = false, signal } = {}) {
      if (forceRefresh) manifestCache = null;
      manifestCache ??= load(signal).catch((error) => {
        manifestCache = null;
        throw error;
      });
      return manifestCache;
    },
    async acquirePublusPageFile(pageIndex, signal) {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new PublusReaderInvalidResponseError('PUBLUS 页序号无效');
      }
      const readPage = (manifest: PublusReaderManifest): PublusPageDescriptor => {
        const page = manifest.pages[pageIndex];
        if (!page) throw new PublusReaderInvalidResponseError('PUBLUS 页面不存在');
        return page;
      };
      const download = (page: PublusPageDescriptor) => options.downloadImage(
        {
          kind: 'remote-image',
          url: page.request.url,
          allowedBaseUrl: page.request.allowedBaseUrl,
          referrerPolicy: 'strict-origin-when-cross-origin',
        },
        { signal },
      );
      let page = readPage(await this.read({ signal }));
      let downloaded;
      try {
        downloaded = await download(page);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        page = readPage(await this.read({ forceRefresh: true, signal }));
        try {
          downloaded = await download(page);
        } catch {
          throw error;
        }
      }
      if (page.restoration.kind === 'none') return downloaded.file;
      return (options.restoreImage ?? restorePublusV1PageImage)(
        downloaded.blob,
        page.restoration.page,
        page.restoration.keys,
        options.document,
        signal,
      );
    },
  };
}
