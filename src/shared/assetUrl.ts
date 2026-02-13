function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '');
}

export function resolveAssetUrl(path: string): string {
  const cleanedPath = trimLeadingSlash(path);
  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { getURL?: (assetPath: string) => string } };
  }).chrome;
  if (chromeApi?.runtime?.getURL) {
    return chromeApi.runtime.getURL(cleanedPath);
  }
  return `/${cleanedPath}`;
}
