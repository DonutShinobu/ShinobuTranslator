import type { ModelRuntime } from '@shinobu/model-runtime';

/** Load and cache the dictionary used by the current Paddle CTC recognizer. */
const charsetCache: Map<string, Promise<string[] | null>> = new Map();

export async function loadCharset(
  modelRuntime: ModelRuntime,
  dictUrl?: string,
): Promise<string[] | null> {
  if (!dictUrl) {
    return null;
  }
  const cached = charsetCache.get(dictUrl);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    let text: string;
    try {
      text = await modelRuntime.readTextResource(dictUrl);
    } catch {
      return null;
    }
    const lines = text
      .split(/\r?\n/g)
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : null;
  })();
  charsetCache.set(dictUrl, promise);
  return promise;
}
