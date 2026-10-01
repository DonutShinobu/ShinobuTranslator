let firstDetectorRequested = false;

/**
 * Start the first detector read without delaying ORT's WASM initialization.
 * Call after the Session cache check and release in createSession's finally.
 */
export function beginFirstDetectorModelPrefetch(
  modelKey: string,
  modelUrl: string,
): (() => void) | undefined {
  if ((globalThis as { __shinobuColdStartModelPrefetch?: boolean }).__shinobuColdStartModelPrefetch !== true
    || modelKey !== 'detector' || typeof modelUrl !== 'string' || !modelUrl || firstDetectorRequested
    || typeof globalThis.fetch !== 'function' || typeof AbortController === 'undefined') return undefined;

  const originalFetch = globalThis.fetch;
  const fetchOriginal = originalFetch.bind(globalThis);
  let controller: AbortController;
  try { controller = new AbortController(); } catch { return undefined; }
  firstDetectorRequested = true;
  let consumed = false;
  let pending: Promise<{ response: Response; bytes?: ArrayBuffer }> | undefined = (async () => {
    const response = await fetchOriginal(modelUrl, { signal: controller.signal });
    const header = response.headers.get('Content-Length');
    const fileSize = header ? Number.parseInt(header, 10) : 0;
    // Same <1 GB branch as ORT 1.27 loadFile. Keep failed/streaming bodies intact.
    const bytes = response.ok && fileSize < 1073741824 ? await response.arrayBuffer() : undefined;
    return { response, bytes };
  })();
  // Speculative failures may happen before ORT asks for the model.
  void pending.catch(() => undefined);

  const restoreFetch = (): void => {
    if (globalThis.fetch === oneUseFetch) {
      try { globalThis.fetch = originalFetch; } catch { /* A locked wrapper still delegates after its one-use slot clears. */ }
    }
  };
  const oneUseFetch: typeof fetch = async (input, init) => {
    // ORT fetches its model as this exact string with no init. A Request, method,
    // headers or caller signal belongs to its original fetch, even for this URL.
    if (!pending || input !== modelUrl || init !== undefined) return fetchOriginal(input, init);
    const prefetched = pending;
    pending = undefined;
    consumed = true;
    restoreFetch();
    try {
      const { response, bytes } = await prefetched;
      // ORT's small-file loader uses ok/headers/arrayBuffer; retain real metadata.
      if (bytes !== undefined) response.arrayBuffer = async () => bytes;
      return response;
    } catch {
      // A speculative read must not select the provider or replace its real error.
      return fetchOriginal(input, init);
    }
  };
  const release = (): void => {
    pending = undefined;
    restoreFetch();
    // Once consumed, the request belongs to ORT and follows its existing lifetime.
    if (!consumed) controller.abort();
  };
  try { globalThis.fetch = oneUseFetch; } catch {
    release();
    return undefined;
  }
  return release;
}
