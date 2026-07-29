import type { ModelAssetSource } from '../../../../src/runtime/modelSource';
import {
  WEB_MODEL_PACKAGE,
  type WebModelPackageManifest,
} from './modelPackage';
import {
  OpfsModelPackageStore,
  type ModelPackageStore,
} from './modelPackageStore';
import { inspectModelPackage } from './modelInstaller';

export type DisposableModelAssetSource = {
  source: ModelAssetSource;
  dispose(): void;
};

export async function createInstalledModelAssetSource(
  store: ModelPackageStore = new OpfsModelPackageStore(),
  manifest: WebModelPackageManifest = WEB_MODEL_PACKAGE,
  rootUrl = globalThis.location.href,
): Promise<DisposableModelAssetSource> {
  const inspection = await inspectModelPackage(store, manifest);
  if (!inspection.installed) {
    throw new Error('模型包尚未完整安装');
  }

  const objectUrls = new Map<string, string>();
  const revocableUrls: string[] = [];
  try {
    for (const asset of manifest.assets) {
      const blob = await store.readAsset(manifest.version, asset.path);
      if (!blob || blob.size !== asset.size) {
        throw new Error(`模型资源缺失或损坏: ${asset.id}`);
      }
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.set(new URL(`/models/${asset.path}`, rootUrl).pathname, objectUrl);
      objectUrls.set(new URL(asset.url, rootUrl).pathname, objectUrl);
      revocableUrls.push(objectUrl);
    }
  } catch (error) {
    for (const url of revocableUrls) URL.revokeObjectURL(url);
    throw error;
  }

  const manifestUrl = new URL('/models/models.json', rootUrl).toString();
  return {
    source: {
      manifestUrl: () => manifestUrl,
      resolveAsset(asset, sourceManifestUrl) {
        const resolved = new URL(asset, sourceManifestUrl).toString();
        return objectUrls.get(new URL(resolved).pathname) ?? resolved;
      },
    },
    dispose() {
      for (const url of revocableUrls) URL.revokeObjectURL(url);
      revocableUrls.length = 0;
      objectUrls.clear();
    },
  };
}
