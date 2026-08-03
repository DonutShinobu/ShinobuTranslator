export interface ModelAssetSource {
  manifestUrl(): string;
  resolveAsset(asset: string, manifestUrl: string): string;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/u.test(value);
}

function resolveAgainstBase(
  asset: string,
  manifestUrl: string,
  rootUrl: string,
): string {
  if (isAbsoluteUrl(asset)) return asset;
  if (asset.startsWith('//')) {
    return `${new URL(rootUrl).protocol}${asset}`;
  }
  if (asset.startsWith('/')) {
    return new URL(asset, rootUrl).toString();
  }
  return new URL(asset, manifestUrl).toString();
}

export function createOriginModelAssetSource(
  rootUrl = globalThis.location?.href ?? 'http://localhost/',
): ModelAssetSource {
  const normalizedRoot = new URL('/', rootUrl).toString();
  return {
    manifestUrl() {
      return new URL('models/models.json', normalizedRoot).toString();
    },
    resolveAsset(asset, manifestUrl) {
      return resolveAgainstBase(asset, manifestUrl, normalizedRoot);
    },
  };
}

export function createExtensionModelAssetSource(
  getAssetUrl: (path: string) => string,
): ModelAssetSource {
  const manifest = getAssetUrl('models/models.json');
  return {
    manifestUrl() {
      return manifest;
    },
    resolveAsset(asset, manifestUrl) {
      if (isAbsoluteUrl(asset)) return asset;
      if (asset.startsWith('//')) {
        return `${new URL(manifest).protocol}${asset}`;
      }
      if (asset.startsWith('/')) {
        return getAssetUrl(asset.replace(/^\/+/u, ''));
      }
      return new URL(asset, manifestUrl).toString();
    },
  };
}
