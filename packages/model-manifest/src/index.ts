export type ModelPackageAsset = {
  id: string;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
};

export type ModelPackageManifest = {
  schemaVersion: 1;
  version: string;
  assets: readonly ModelPackageAsset[];
};

export const MODEL_PACKAGE = manifest as ModelPackageManifest;
export const MODEL_GATEWAY_COMPATIBILITY_PACKAGES =
  compatibility.packages as readonly ModelPackageManifest[];

export function modelGatewayPath(asset: ModelPackageAsset): string {
  return `/v1/models/${asset.sha256}/${asset.path}`;
}

export function modelR2Key(asset: ModelPackageAsset): string {
  return `models/${asset.sha256}/${asset.path}`;
}

export function buildModelGatewayAllowlist(
  packages: readonly ModelPackageManifest[],
): Map<string, ModelPackageAsset> {
  const allowlist = new Map<string, ModelPackageAsset>();
  for (const modelPackage of packages) {
    for (const asset of modelPackage.assets) {
      const path = modelGatewayPath(asset);
      const existing = allowlist.get(path);
      if (
        existing
        && (
          existing.id !== asset.id
          || existing.size !== asset.size
          || existing.mediaType !== asset.mediaType
        )
      ) {
        throw new Error(`Conflicting model gateway asset metadata: ${path}`);
      }
      allowlist.set(path, asset);
    }
  }
  return allowlist;
}

export const MODEL_GATEWAY_ALLOWLIST = buildModelGatewayAllowlist([
  MODEL_PACKAGE,
  ...MODEL_GATEWAY_COMPATIBILITY_PACKAGES,
]);
import compatibility from '../compatibility.json';
import manifest from '../manifest.json';
