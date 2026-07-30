import { isNodeRuntime } from '@shinobu/browser-runtime/runtime-target';

/** Load and cache the dictionary used by the current Paddle CTC recognizer. */
const charsetCache: Map<string, Promise<string[] | null>> = new Map();

export async function loadCharset(dictUrl?: string): Promise<string[] | null> {
  if (!dictUrl) {
    return null;
  }
  const cached = charsetCache.get(dictUrl);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    if (isNodeRuntime) {
      // Node: read from local file system via dynamic import of Node-only module
      const { loadCharsetNode } = await import('./ocrSharedNode');
      return loadCharsetNode(dictUrl);
    }
    // Browser: fetch from URL
    const response = await fetch(dictUrl, { method: "GET" });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const lines = text
      .split(/\r?\n/g)
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : null;
  })();
  charsetCache.set(dictUrl, promise);
  return promise;
}
