import {
  MIN_MODEL_INSTALL_AVAILABLE_BYTES,
  type WebModelAsset,
  type WebModelPackageManifest,
} from './modelPackage';
import {
  createModelPackageReceipt,
  isReceiptForManifest,
  type ModelPackageStore,
} from './modelPackageStore';

export type ModelInstallPhase = 'downloading' | 'verifying' | 'complete';

export type ModelInstallProgress = {
  phase: ModelInstallPhase;
  assetId?: string;
  assetIndex: number;
  assetCount: number;
  downloadedBytes: number;
  totalBytes: number;
};

export type ModelPackageInspection = {
  installed: boolean;
  storedBytes: number;
  totalBytes: number;
};

export class ModelInstallError extends Error {
  constructor(
    readonly code:
      | 'STORAGE_UNAVAILABLE'
      | 'INSUFFICIENT_STORAGE'
      | 'DOWNLOAD_FAILED'
      | 'RANGE_UNSUPPORTED'
      | 'SIZE_MISMATCH'
      | 'INTEGRITY_MISMATCH',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelInstallError';
  }
}

export type StorageCapacity = {
  availableBytes?: number;
  requiredBytes: number;
  persisted: boolean;
};

type InstallOptions = {
  manifest: WebModelPackageManifest;
  store: ModelPackageStore;
  signal?: AbortSignal;
  onProgress?: (progress: ModelInstallProgress) => void;
  fetchImpl?: typeof fetch;
  digest?: (blob: Blob) => Promise<string>;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('模型下载已取消', 'AbortError');
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return toHex(new Uint8Array(digest));
}

async function storedAssetSize(
  store: ModelPackageStore,
  manifest: WebModelPackageManifest,
  asset: WebModelAsset,
): Promise<number> {
  const blob = await store.readAsset(manifest.version, asset.path);
  return Math.min(blob?.size ?? 0, asset.size);
}

export async function inspectModelPackage(
  store: ModelPackageStore,
  manifest: WebModelPackageManifest,
): Promise<ModelPackageInspection> {
  const receipt = await store.readCurrent();
  const sizes = await Promise.all(
    manifest.assets.map((asset) => storedAssetSize(store, manifest, asset)),
  );
  const storedBytes = sizes.reduce((total, size) => total + size, 0);
  const filesComplete = sizes.every((size, index) => size === manifest.assets[index].size);
  return {
    installed: filesComplete && isReceiptForManifest(receipt, manifest),
    storedBytes,
    totalBytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
  };
}

export async function ensureModelStorageCapacity(
  storage: Pick<StorageManager, 'estimate' | 'persist'> = navigator.storage,
): Promise<StorageCapacity> {
  let estimate: StorageEstimate;
  try {
    estimate = await storage.estimate();
  } catch (error) {
    throw new ModelInstallError(
      'STORAGE_UNAVAILABLE',
      '无法读取浏览器存储配额',
      { cause: error },
    );
  }
  const availableBytes = typeof estimate.quota === 'number'
    ? Math.max(0, estimate.quota - (estimate.usage ?? 0))
    : undefined;
  if (
    availableBytes !== undefined
    && availableBytes < MIN_MODEL_INSTALL_AVAILABLE_BYTES
  ) {
    throw new ModelInstallError(
      'INSUFFICIENT_STORAGE',
      `模型安装至少需要 ${Math.ceil(MIN_MODEL_INSTALL_AVAILABLE_BYTES / 1024 / 1024)} MiB 可用站点空间`,
    );
  }
  let persisted = false;
  try {
    persisted = await storage.persist();
  } catch {
    // Persistence is best effort and does not block installation.
  }
  return {
    availableBytes,
    requiredBytes: MIN_MODEL_INSTALL_AVAILABLE_BYTES,
    persisted,
  };
}

function validatePartialResponse(
  response: Response,
  offset: number,
  expectedSize: number,
): void {
  if (response.status !== 206) return;
  const contentRange = response.headers.get('content-range');
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu.exec(contentRange ?? '');
  if (
    !match
    || Number(match[1]) !== offset
    || match[3] === '*'
    || Number(match[3]) !== expectedSize
  ) {
    throw new ModelInstallError(
      'RANGE_UNSUPPORTED',
      '模型服务器返回了无效的 Range 响应',
    );
  }
}

async function verifyStoredAsset(
  store: ModelPackageStore,
  manifest: WebModelPackageManifest,
  asset: WebModelAsset,
  digest: (blob: Blob) => Promise<string>,
): Promise<boolean> {
  const blob = await store.readAsset(manifest.version, asset.path);
  if (!blob || blob.size !== asset.size) return false;
  return (await digest(blob)).toLowerCase() === asset.sha256;
}

async function downloadAsset(
  options: InstallOptions,
  asset: WebModelAsset,
  initialOffset: number,
  reportDownloaded: (assetBytes: number) => void,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let offset = initialOffset;
  if (offset > asset.size) {
    await options.store.clearAsset(options.manifest.version, asset.path);
    offset = 0;
  }

  throwIfAborted(options.signal);
  const headers = new Headers();
  if (offset > 0) headers.set('Range', `bytes=${offset}-`);
  let response: Response;
  try {
    response = await fetchImpl(asset.url, {
      method: 'GET',
      headers,
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    throwIfAborted(options.signal);
    throw new ModelInstallError(
      'DOWNLOAD_FAILED',
      `模型下载失败: ${asset.id}`,
      { cause: error },
    );
  }

  if (offset > 0 && response.status === 200) {
    await options.store.clearAsset(options.manifest.version, asset.path);
    offset = 0;
    reportDownloaded(0);
  } else {
    validatePartialResponse(response, offset, asset.size);
  }
  if (!response.ok) {
    throw new ModelInstallError(
      'DOWNLOAD_FAILED',
      `模型下载失败: ${asset.id} (HTTP ${response.status})`,
    );
  }
  if (!response.body) {
    throw new ModelInstallError('DOWNLOAD_FAILED', `模型响应没有数据流: ${asset.id}`);
  }

  const writer = await options.store.openAssetWriter(
    options.manifest.version,
    asset.path,
    offset,
  );
  const reader = response.body.getReader();
  let downloaded = offset;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (downloaded + value.byteLength > asset.size) {
        throw new ModelInstallError(
          'SIZE_MISMATCH',
          `模型大小超过内置清单: ${asset.id}`,
        );
      }
      await writer.write(value);
      downloaded += value.byteLength;
      reportDownloaded(downloaded);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await writer.close();
  }
  if (downloaded !== asset.size) {
    throw new ModelInstallError(
      'SIZE_MISMATCH',
      `模型大小与内置清单不一致: ${asset.id}`,
    );
  }
}

export async function installModelPackage(options: InstallOptions): Promise<void> {
  const digest = options.digest ?? sha256Blob;
  const totalBytes = options.manifest.assets.reduce(
    (total, asset) => total + asset.size,
    0,
  );
  const storedSizes = await Promise.all(
    options.manifest.assets.map((asset) =>
      storedAssetSize(options.store, options.manifest, asset)),
  );
  let completedBeforeAsset = 0;

  for (let index = 0; index < options.manifest.assets.length; index += 1) {
    throwIfAborted(options.signal);
    const asset = options.manifest.assets[index];
    let offset = storedSizes[index];
    if (offset === asset.size) {
      options.onProgress?.({
        phase: 'verifying',
        assetId: asset.id,
        assetIndex: index,
        assetCount: options.manifest.assets.length,
        downloadedBytes: completedBeforeAsset + offset,
        totalBytes,
      });
      if (await verifyStoredAsset(options.store, options.manifest, asset, digest)) {
        completedBeforeAsset += asset.size;
        continue;
      }
      await options.store.clearAsset(options.manifest.version, asset.path);
      offset = 0;
    }

    const reportDownloaded = (assetBytes: number): void => {
      options.onProgress?.({
        phase: 'downloading',
        assetId: asset.id,
        assetIndex: index,
        assetCount: options.manifest.assets.length,
        downloadedBytes: completedBeforeAsset + assetBytes,
        totalBytes,
      });
    };
    reportDownloaded(offset);
    await downloadAsset(options, asset, offset, reportDownloaded);
    options.onProgress?.({
      phase: 'verifying',
      assetId: asset.id,
      assetIndex: index,
      assetCount: options.manifest.assets.length,
      downloadedBytes: completedBeforeAsset + asset.size,
      totalBytes,
    });
    if (!await verifyStoredAsset(options.store, options.manifest, asset, digest)) {
      await options.store.clearAsset(options.manifest.version, asset.path);
      throw new ModelInstallError(
        'INTEGRITY_MISMATCH',
        `模型哈希校验失败: ${asset.id}`,
      );
    }
    completedBeforeAsset += asset.size;
  }

  throwIfAborted(options.signal);
  await options.store.commit(createModelPackageReceipt(options.manifest));
  options.onProgress?.({
    phase: 'complete',
    assetIndex: options.manifest.assets.length,
    assetCount: options.manifest.assets.length,
    downloadedBytes: totalBytes,
    totalBytes,
  });
}
