import {
  MODEL_PACKAGE,
  modelGatewayPath,
} from '@shinobu/model-manifest';

export type WebModelAsset = {
  id: string;
  path: string;
  url: string;
  size: number;
  sha256: string;
};

export type WebModelPackageManifest = {
  schemaVersion: 1;
  version: string;
  assets: readonly WebModelAsset[];
};

function modelUrl(path: string, gatewayPath: string): string {
  const origin = (
    import.meta as ImportMeta & {
      env?: { VITE_MODEL_GATEWAY_ORIGIN?: string };
    }
  ).env?.VITE_MODEL_GATEWAY_ORIGIN?.trim().replace(/\/+$/u, '');
  return origin ? `${origin}${gatewayPath}` : `/models/${path}`;
}

export const WEB_MODEL_PACKAGE = {
  schemaVersion: MODEL_PACKAGE.schemaVersion,
  version: MODEL_PACKAGE.version,
  assets: MODEL_PACKAGE.assets.map((asset) => ({
    id: asset.id,
    path: asset.path,
    url: modelUrl(asset.path, modelGatewayPath(asset)),
    size: asset.size,
    sha256: asset.sha256,
  })),
} as const satisfies WebModelPackageManifest;

export const WEB_MODEL_PACKAGE_SIZE = WEB_MODEL_PACKAGE.assets.reduce(
  (total, asset) => total + asset.size,
  0,
);

export const MIN_MODEL_INSTALL_AVAILABLE_BYTES = Math.max(
  600 * 1024 * 1024,
  2 * WEB_MODEL_PACKAGE_SIZE + 100 * 1024 * 1024,
);
