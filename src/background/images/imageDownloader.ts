import type {
  DocumentReferrerPolicy,
  DocumentReferrerPolicyObserver,
  ExtensionStorage,
  RequestHeaderOverride,
  RequestHeaderOverrideLease,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionOperationError,
} from '../../../apps/extension/src/capabilities/errors';
import type {
  TabDocumentSource,
} from '../../../apps/extension/src/capabilities/guards';
import { normalizeJsonValue } from '../../shared/jsonValue';
import { isReferrerPolicy } from '../../shared/referrerPolicy';
import { arrayBufferToBase64, toErrorMessage } from '../../shared/utils';

const defaultDownloadTimeoutMs = 30_000;
const documentPolicyStorageKey = 'mangaTranslate.documentReferrerPolicies';
const maxTrackedDocumentPolicies = 256;

export type ImageDownloadRequest = {
  imageUrl: string;
  referrerPolicy?: ReferrerPolicy;
};

export type DownloadedImage = {
  base64: string;
  contentType: string;
  sourceUrl: string;
};

export type ImageDownloader = {
  download(
    request: ImageDownloadRequest,
    source: TabDocumentSource,
  ): Promise<DownloadedImage>;
};

export type ImageDownloaderDependencies = {
  sessionStorage: ExtensionStorage;
  referrerPolicies: DocumentReferrerPolicyObserver;
  requestHeaderOverride: RequestHeaderOverride;
  fetchImage?: typeof fetch;
  timeoutMs?: number;
};

type ImageAttemptFailure = {
  candidateIndex: number;
  candidateCount: number;
  hostname: string;
  reason: string;
  durationMs: number;
  refererApplied: boolean;
};

type TrackedDocumentPolicy = {
  documentUrlHash: string;
  policy: ReferrerPolicy;
  updatedAt: number;
};

type DocumentPolicyTracker = {
  get(source: TabDocumentSource): Promise<ReferrerPolicy | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getDocumentPolicyKeys(details: {
  documentId?: string;
  tabId?: number;
  frameId?: number;
}): string[] {
  const keys: string[] = [];
  if (details.documentId) keys.push(`document:${details.documentId}`);
  if (typeof details.tabId === 'number' && details.tabId >= 0 && typeof details.frameId === 'number') {
    keys.push(`frame:${details.tabId}:${details.frameId}`);
  }
  return keys;
}

function extractReferrerPolicy(value: string | undefined): ReferrerPolicy | undefined {
  let policy: ReferrerPolicy | undefined;
  for (const token of value?.split(',') ?? []) {
    const candidate = token.trim().toLowerCase();
    if (candidate && isReferrerPolicy(candidate)) policy = candidate;
  }
  return policy;
}

function normalizeDocumentUrlForPolicyMatch(value: string): string | undefined {
  try {
    const url = parseHttpUrl(value, '页面地址');
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

async function hashDocumentUrl(value: string): Promise<string | undefined> {
  const normalized = normalizeDocumentUrlForPolicyMatch(value);
  const subtle = globalThis.crypto?.subtle;
  if (!normalized || !subtle) return undefined;
  try {
    const digest = await subtle.digest(
      'SHA-256',
      new TextEncoder().encode(normalized),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

function createDocumentPolicyTracker(
  observer: DocumentReferrerPolicyObserver,
  sessionStorage: ExtensionStorage,
): DocumentPolicyTracker {
  const policies = new Map<string, TrackedDocumentPolicy>();
  const locallyUpdatedKeys = new Set<string>();
  const pendingUpdates = new Map<string, Promise<void>>();
  const keyRevisions = new Map<string, number>();
  let nextRevision = 0;
  let storageLoaded = false;
  let persistRequested = false;
  let persistTail: Promise<void> = Promise.resolve();

  const trimPolicies = (): void => {
    while (policies.size > maxTrackedDocumentPolicies) {
      const oldestKey = policies.keys().next().value as string | undefined;
      if (!oldestKey) break;
      policies.delete(oldestKey);
    }
  };

  const queuePersist = (): void => {
    if (!storageLoaded) {
      persistRequested = true;
      return;
    }
    persistTail = persistTail
      .catch(() => undefined)
      .then(async () => {
        await sessionStorage.write({
          [documentPolicyStorageKey]: normalizeJsonValue(
            Object.fromEntries(policies),
          ),
        });
      })
      .catch(() => undefined);
  };

  const ready = (async () => {
    try {
      const stored = await sessionStorage.read([documentPolicyStorageKey]);
      const snapshot = stored[documentPolicyStorageKey];
      if (!isRecord(snapshot)) return;
      const entries: Array<[string, TrackedDocumentPolicy]> = [];
      for (const [key, value] of Object.entries(snapshot)) {
        if (
          locallyUpdatedKeys.has(key)
          || !isRecord(value)
          || !isReferrerPolicy(value.policy)
          || !value.policy
          || typeof value.documentUrlHash !== 'string'
          || !/^[\da-f]{64}$/u.test(value.documentUrlHash)
          || typeof value.updatedAt !== 'number'
        ) continue;
        entries.push([key, {
          documentUrlHash: value.documentUrlHash,
          policy: value.policy,
          updatedAt: value.updatedAt,
        }]);
      }
      entries.sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      for (const [key, value] of entries) policies.set(key, value);
      trimPolicies();
    } catch {
      // Session persistence is an optimization; live observations still work.
    } finally {
      storageLoaded = true;
      locallyUpdatedKeys.clear();
      if (persistRequested) {
        persistRequested = false;
        queuePersist();
      }
    }
  })();

  const listener = (observation: DocumentReferrerPolicy): void => {
    const keys = getDocumentPolicyKeys(observation.document);
    if (keys.length === 0) return;
    const policy = extractReferrerPolicy(observation.policy);
    const revision = nextRevision + 1;
    nextRevision = revision;
    for (const key of keys) {
      if (!storageLoaded) locallyUpdatedKeys.add(key);
      keyRevisions.set(key, revision);
      policies.delete(key);
    }
    trimPolicies();
    if (!policy) {
      for (const key of keys) {
        if (keyRevisions.get(key) === revision) keyRevisions.delete(key);
      }
      queuePersist();
      return;
    }

    const update = (async () => {
      const documentUrlHash = await hashDocumentUrl(observation.document.url);
      const updatedAt = Date.now();
      for (const key of keys) {
        if (keyRevisions.get(key) !== revision) continue;
        policies.delete(key);
        if (documentUrlHash) {
          policies.set(key, {
            documentUrlHash,
            policy,
            updatedAt,
          });
        }
        keyRevisions.delete(key);
      }
      trimPolicies();
      queuePersist();
    })();
    for (const key of keys) pendingUpdates.set(key, update);
    void update.finally(() => {
      for (const key of keys) {
        if (pendingUpdates.get(key) === update) pendingUpdates.delete(key);
      }
    });
  };

  observer.onObserved(listener);

  return {
    async get(source) {
      await ready;
      const keys = getDocumentPolicyKeys({
        documentId: source.documentId,
        tabId: source.tabId,
        frameId: source.frameId,
      });
      await Promise.all(keys.map((key) => pendingUpdates.get(key)));
      const trustedDocumentUrl = getTrustedDocumentUrl(source);
      if (!trustedDocumentUrl) return undefined;
      const documentUrlHash = await hashDocumentUrl(trustedDocumentUrl.toString());
      if (!documentUrlHash) return undefined;
      for (const key of keys) {
        const tracked = policies.get(key);
        if (tracked?.documentUrlHash === documentUrlHash) return tracked.policy;
      }
      return undefined;
    },
  };
}

function buildOriginalCandidates(imageUrl: string): string[] {
  const urls: string[] = [];
  const parsed = new URL(imageUrl);
  if (
    parsed.hostname === 'pbs.twimg.com'
    && (parsed.searchParams.has('name') || parsed.searchParams.has('format'))
  ) {
    const withOrig = new URL(parsed.toString());
    withOrig.searchParams.set('name', 'orig');
    urls.push(withOrig.toString());
  }
  urls.push(imageUrl);
  return Array.from(new Set(urls));
}

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}不是有效 URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}仅支持 HTTP/HTTPS`);
  }
  return parsed;
}

function getTrustedDocumentUrl(source: TabDocumentSource): URL | undefined {
  if (!source.url) return undefined;
  try {
    return parseHttpUrl(source.url, '页面地址');
  } catch {
    return undefined;
  }
}

function toSanitizedFullReferrer(source: URL): string {
  const sanitized = new URL(source.toString());
  sanitized.username = '';
  sanitized.password = '';
  sanitized.hash = '';
  return sanitized.toString();
}

function toOriginReferrer(source: URL): string {
  return `${source.origin}/`;
}

function computeReferrer(
  source: URL | undefined,
  target: URL,
  policy: ReferrerPolicy | undefined,
): string | undefined {
  if (!source) return undefined;

  const effectivePolicy = policy || 'strict-origin-when-cross-origin';
  const sameOrigin = source.origin === target.origin;
  const isDowngrade = source.protocol === 'https:' && target.protocol === 'http:';
  const origin = toOriginReferrer(source);
  const serializedFull = toSanitizedFullReferrer(source);
  const full = serializedFull.length > 4_096 ? origin : serializedFull;

  switch (effectivePolicy) {
    case 'no-referrer':
      return undefined;
    case 'no-referrer-when-downgrade':
      return isDowngrade ? undefined : full;
    case 'origin':
      return origin;
    case 'origin-when-cross-origin':
      return sameOrigin ? full : origin;
    case 'same-origin':
      return sameOrigin ? full : undefined;
    case 'strict-origin':
      return isDowngrade ? undefined : origin;
    case 'strict-origin-when-cross-origin':
      if (sameOrigin) return full;
      return isDowngrade ? undefined : origin;
    case 'unsafe-url':
      return full;
    default:
      return undefined;
  }
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function detectImageContentType(buffer: ArrayBuffer, declaredContentType: string): string | undefined {
  const bytes = new Uint8Array(buffer);
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (readAscii(bytes, 0, 6) === 'GIF87a' || readAscii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (readAscii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (
    startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00])
    || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) return 'image/tiff';
  if (startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';

  if (readAscii(bytes, 4, 4) === 'ftyp') {
    const brands = readAscii(bytes, 8, Math.min(24, Math.max(0, bytes.length - 8)));
    if (/(?:avif|avis)/u.test(brands)) return 'image/avif';
    if (/(?:heic|heix|hevc|hevx|mif1|msf1)/u.test(brands)) return 'image/heif';
  }

  const normalizedDeclaredType = declaredContentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalizedDeclaredType === 'image/svg+xml') {
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 1024)))
      .replace(/^\uFEFF/u, '')
      .trimStart();
    if (/^(?:<\?xml[\s\S]*?)?<svg(?:\s|>)/iu.test(prefix)) return 'image/svg+xml';
  }

  return undefined;
}

function toSanitizedErrorMessage(error: unknown): string {
  const message = toErrorMessage(error)
    .replace(/\bhttps?:\/\/[^\s"'<>)}\]]+/giu, '[URL_REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim();
  return message || '未知错误';
}

function formatAttemptFailure(failure: ImageAttemptFailure): string {
  const details = [
    `候选 ${failure.candidateIndex}/${failure.candidateCount}`,
    `host=${failure.hostname}`,
    `referer=${failure.refererApplied ? 'page-context' : 'none'}`,
    failure.reason,
    `duration=${failure.durationMs}ms`,
  ];
  return details.join(', ');
}

async function releaseHeaderOverrideLease(
  lease: RequestHeaderOverrideLease,
): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    if (
      !(error instanceof ExtensionOperationError)
      || error.capability !== 'request-header-override'
      || error.operation !== 'release'
      || !error.retryable
    ) {
      throw error;
    }
    await lease.release();
  }
}

export function createImageDownloader(
  dependencies: ImageDownloaderDependencies,
): ImageDownloader {
  const documentPolicyTracker = createDocumentPolicyTracker(
    dependencies.referrerPolicies,
    dependencies.sessionStorage,
  );
  const fetchImage = dependencies.fetchImage
    ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = dependencies.timeoutMs ?? defaultDownloadTimeoutMs;

  async function download(
    request: ImageDownloadRequest,
    source: TabDocumentSource,
  ): Promise<DownloadedImage> {
    parseHttpUrl(request.imageUrl, '图片地址');
    const trustedDocumentUrl = getTrustedDocumentUrl(source);
    const candidates = buildOriginalCandidates(request.imageUrl);
    const effectiveReferrerPolicy = request.referrerPolicy
      || await documentPolicyTracker.get(source);
    const failures: ImageAttemptFailure[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const targetUrl = parseHttpUrl(candidate, '图片地址');
      const referer = computeReferrer(trustedDocumentUrl, targetUrl, effectiveReferrerPolicy);
      const startedAt = Date.now();
      let headerOverrideLease: RequestHeaderOverrideLease | undefined;

      if (referer) {
        headerOverrideLease = await dependencies.requestHeaderOverride.acquire({
          url: candidate,
          headers: [{
            name: 'Referer',
            value: referer,
          }],
        });
      }

      const abortController = new AbortController();
      let timedOut = false;
      let downloadedImage: DownloadedImage | undefined;
      const timeoutHandle = globalThis.setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);

      try {
        const response = await fetchImage(candidate, {
          method: 'GET',
          credentials: 'include',
          cache: 'default',
          redirect: 'follow',
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) {
          throw new Error('返回空文件');
        }
        const declaredContentType = response.headers.get('content-type') ?? '';
        const contentType = detectImageContentType(buffer, declaredContentType);
        if (!contentType) {
          const normalizedType = declaredContentType.split(';', 1)[0]?.trim().toLowerCase();
          throw new Error(
            normalizedType === 'text/html'
              ? '服务器返回了 HTML，未返回原始图片'
              : `响应不是支持的图片格式${normalizedType ? `（${normalizedType}）` : ''}`,
          );
        }

        downloadedImage = {
          base64: arrayBufferToBase64(buffer),
          contentType,
          sourceUrl: response.url || candidate,
        };
      } catch (error) {
        failures.push({
          candidateIndex: index + 1,
          candidateCount: candidates.length,
          hostname: targetUrl.hostname,
          reason: timedOut ? `请求超时（${timeoutMs}ms）` : toSanitizedErrorMessage(error),
          durationMs: Math.max(0, Date.now() - startedAt),
          refererApplied: Boolean(headerOverrideLease),
        });
      } finally {
        globalThis.clearTimeout(timeoutHandle);
        if (headerOverrideLease) {
          await releaseHeaderOverrideLease(headerOverrideLease);
        }
      }
      if (downloadedImage) {
        return downloadedImage;
      }
    }

    throw new Error(
      `无法取得原始图片字节: ${failures.map(formatAttemptFailure).join(' | ') || '未知错误'}`,
    );
  }

  return {
    download,
  };
}
