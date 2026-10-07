import { getActiveContentSessionId } from '../../../shared/contentSession';
import { getExtensionApi } from '../../../shared/extensionRuntime';
import type { sendRuntimeMessage } from '../../../shared/messages';
import { parseCredentiallessHttpsUrl } from '../../../shared/restrictedResourceUrl';

type PageImageSource = {
  url: string;
  pageImageUrl?: string;
  referrerPolicy?: ReferrerPolicy;
  allowedBaseUrl?: string;
};

function getXPageImageUrl(source: PageImageSource): string | undefined {
  if (!source.pageImageUrl || source.allowedBaseUrl
    || typeof window === 'undefined'
    || !['x.com', 'twitter.com'].includes(window.location.hostname)
    || getExtensionApi()?.runtime?.getManifest?.().manifest_version !== 3) return undefined;
  const original = parseCredentiallessHttpsUrl(source.url);
  const displayed = parseCredentiallessHttpsUrl(source.pageImageUrl);
  if (!original || !displayed
      || original.origin !== 'https://pbs.twimg.com' || displayed.origin !== 'https://pbs.twimg.com'
      || !displayed.pathname.startsWith('/media/')
      || original.pathname !== displayed.pathname
      || original.searchParams.get('format') !== displayed.searchParams.get('format')
      || displayed.searchParams.getAll('name').length !== 1 || displayed.hash) return undefined;
  return displayed.href;
}

/** Chrome's page-origin fetch can reuse the no-Origin HTTP cache entry loaded by <img>. */
export async function tryDownloadXPageImage(
  source: PageImageSource,
  signal: AbortSignal,
  sendMessage: typeof sendRuntimeMessage,
): Promise<{ blob: Blob; sourceUrl: string } | undefined> {
  const imageUrl = getXPageImageUrl(source);
  if (!imageUrl || signal.aborted) return undefined;
  const contentSessionId = getActiveContentSessionId();
  const session = contentSessionId ? { contentSessionId } : {};
  let ruleId: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  try {
    const prepared = await sendMessage({ type: 'mt:prepare-page-image-cache', imageUrl, ...session });
    if (!prepared.ok || prepared.type !== 'mt:prepare-page-image-cache') return undefined;
    ruleId = prepared.ruleId;
    if (signal.aborted) return undefined;
    signal.addEventListener('abort', onAbort, { once: true });
    timeoutHandle = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(imageUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
      redirect: 'error',
      referrerPolicy: source.referrerPolicy,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith('image/')) return undefined;
    return { blob, sourceUrl: imageUrl };
  } catch {
    // Unsupported DNR, CORS errors and failed responses retain the original downloader.
    return undefined;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    if (ruleId !== undefined) {
      try {
        await sendMessage({ type: 'mt:release-page-image-cache', ruleId, ...session });
      } catch {
        // The background lease also expires if the content context disappears.
      }
    }
  }
}
