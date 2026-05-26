/**
 * Node-only charset loading utility.
 *
 * Separated from ocrShared.ts so that Vite can externalize this file
 * for the browser build. The browser build uses fetch() in ocrShared.ts.
 */

export async function loadCharsetNode(dictUrl: string): Promise<string[] | null> {
  const fs = await import('fs');
  const text = fs.readFileSync(dictUrl, 'utf-8');
  const lines = text
    .split(/\r?\n/g)
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : null;
}