import {
  isUrlWithinRestrictedResourceBase,
  parseCredentiallessHttpsUrl,
  parseRestrictedResourceBaseUrl,
} from '../../shared/restrictedResourceUrl';

const defaultTimeoutMs = 30_000;
const defaultMaximumBytes = 8 * 1024 * 1024;

export type ReaderResourceRequest = {
  url: string;
  allowedBaseUrl: string;
};

export type ReaderResourceResponse = {
  text: string;
  contentType: string;
  sourceUrl: string;
};

export type ReaderResourceFetcher = {
  fetch(request: ReaderResourceRequest): Promise<ReaderResourceResponse>;
};

type ReaderResourceFetcherDependencies = {
  fetchResource?: typeof fetch;
  timeoutMs?: number;
  maximumBytes?: number;
};

function parseHttpsUrl(value: string, label: string): URL {
  const parsed = parseCredentiallessHttpsUrl(value);
  if (!parsed) {
    throw new Error(`${label}必须是无凭据的 HTTPS URL`);
  }
  return parsed;
}

function parseBaseUrl(value: string): URL {
  const base = parseRestrictedResourceBaseUrl(value);
  if (!base) throw new Error('允许的资源范围必须是无凭据、无查询参数的 HTTPS URL');
  return base;
}

function isWithinBase(target: URL, base: URL): boolean {
  return isUrlWithinRestrictedResourceBase(target, base);
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  abortController: AbortController,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) throw new Error('阅读器资源响应超过大小上限');
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('阅读器资源响应超过大小上限').catch(() => undefined);
        abortController.abort();
        throw new Error('阅读器资源响应超过大小上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponse(
  response: Response,
  abortController: AbortController,
): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
  abortController.abort();
}

export function createReaderResourceFetcher(
  dependencies: ReaderResourceFetcherDependencies = {},
): ReaderResourceFetcher {
  const fetchResource = dependencies.fetchResource ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = dependencies.timeoutMs ?? defaultTimeoutMs;
  const maximumBytes = dependencies.maximumBytes ?? defaultMaximumBytes;
  return {
    async fetch(request) {
      const target = parseHttpsUrl(request.url, '阅读器资源地址');
      const base = parseBaseUrl(request.allowedBaseUrl);
      if (!isWithinBase(target, base)) throw new Error('阅读器资源地址超出允许范围');
      const abortController = new AbortController();
      const timeout = globalThis.setTimeout(() => abortController.abort(), timeoutMs);
      try {
        const response = await fetchResource(target.href, {
          method: 'GET',
          credentials: 'include',
          cache: 'default',
          redirect: 'error',
          signal: abortController.signal,
        });
        if (!response.ok) {
          await cancelResponse(response, abortController);
          throw new Error(`阅读器资源请求失败: HTTP ${response.status}`);
        }
        let source: URL;
        try {
          source = parseHttpsUrl(response.url || target.href, '阅读器资源响应地址');
        } catch (error) {
          await cancelResponse(response, abortController);
          throw error;
        }
        if (!isWithinBase(source, base)) {
          await cancelResponse(response, abortController);
          throw new Error('阅读器资源响应地址超出允许范围');
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
          await cancelResponse(response, abortController);
          throw new Error('阅读器资源响应超过大小上限');
        }
        const bytes = await readResponseBytes(response, maximumBytes, abortController);
        return {
          text: new TextDecoder().decode(bytes),
          contentType: response.headers.get('content-type') ?? '',
          sourceUrl: source.href,
        };
      } finally {
        globalThis.clearTimeout(timeout);
      }
    },
  };
}
