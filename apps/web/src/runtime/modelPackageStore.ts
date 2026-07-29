import type {
  WebModelAsset,
  WebModelPackageManifest,
} from './modelPackage';

export type ModelPackageReceipt = {
  schemaVersion: 1;
  packageVersion: string;
  installedAt: string;
  assets: Array<Pick<WebModelAsset, 'path' | 'size' | 'sha256'>>;
};

export interface ModelAssetWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ModelPackageStore {
  readCurrent(): Promise<ModelPackageReceipt | null>;
  readAsset(packageVersion: string, path: string): Promise<Blob | null>;
  openAssetWriter(
    packageVersion: string,
    path: string,
    offset: number,
  ): Promise<ModelAssetWriter>;
  clearAsset(packageVersion: string, path: string): Promise<void>;
  commit(receipt: ModelPackageReceipt): Promise<void>;
}

const ROOT_DIRECTORY = 'shinobu-translator';
const MODELS_DIRECTORY = 'model-packages';
const CURRENT_RECEIPT_FILE = 'current.json';

function assertSafePath(path: string): string[] {
  const parts = path.split('/');
  if (
    parts.length === 0
    || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new Error(`无效模型资源路径: ${path}`);
  }
  return parts;
}

async function getDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

async function getFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  try {
    return await directory.getFileHandle(name, { create });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

export class OpfsModelPackageStore implements ModelPackageStore {
  constructor(
    private readonly rootProvider: () => Promise<FileSystemDirectoryHandle> = () =>
      navigator.storage.getDirectory(),
  ) {}

  async readCurrent(): Promise<ModelPackageReceipt | null> {
    const root = await this.getModelRoot(false);
    if (!root) return null;
    const handle = await getFile(root, CURRENT_RECEIPT_FILE, false);
    if (!handle) return null;
    try {
      const value = JSON.parse(await (await handle.getFile()).text()) as unknown;
      return isModelPackageReceipt(value) ? value : null;
    } catch {
      return null;
    }
  }

  async readAsset(packageVersion: string, path: string): Promise<Blob | null> {
    const directory = await this.getAssetDirectory(packageVersion, path, false);
    if (!directory) return null;
    const parts = assertSafePath(path);
    const handle = await getFile(directory, parts.at(-1)!, false);
    return handle ? handle.getFile() : null;
  }

  async openAssetWriter(
    packageVersion: string,
    path: string,
    offset: number,
  ): Promise<ModelAssetWriter> {
    const directory = await this.getAssetDirectory(packageVersion, path, true);
    if (!directory) throw new Error('无法创建模型目录');
    const parts = assertSafePath(path);
    const handle = await getFile(directory, parts.at(-1)!, true);
    if (!handle) throw new Error('无法创建模型文件');
    const stream = await handle.createWritable({ keepExistingData: true });
    await stream.seek(offset);
    let closed = false;
    return {
      async write(chunk) {
        if (closed) throw new Error('模型写入流已关闭');
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        await stream.write(copy);
      },
      async close() {
        if (closed) return;
        closed = true;
        await stream.close();
      },
    };
  }

  async clearAsset(packageVersion: string, path: string): Promise<void> {
    const directory = await this.getAssetDirectory(packageVersion, path, true);
    if (!directory) throw new Error('无法打开模型目录');
    const parts = assertSafePath(path);
    const handle = await getFile(directory, parts.at(-1)!, true);
    if (!handle) throw new Error('无法打开模型文件');
    const stream = await handle.createWritable();
    await stream.close();
  }

  async commit(receipt: ModelPackageReceipt): Promise<void> {
    const root = await this.getModelRoot(true);
    if (!root) throw new Error('无法创建模型存储根目录');
    const handle = await getFile(root, CURRENT_RECEIPT_FILE, true);
    if (!handle) throw new Error('无法创建模型安装记录');
    const stream = await handle.createWritable();
    await stream.write(JSON.stringify(receipt));
    await stream.close();
  }

  private async getModelRoot(create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const storageRoot = await this.rootProvider();
    const appRoot = await getDirectory(storageRoot, ROOT_DIRECTORY, create);
    return appRoot ? getDirectory(appRoot, MODELS_DIRECTORY, create) : null;
  }

  private async getAssetDirectory(
    packageVersion: string,
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    const safeVersion = assertSafePath(packageVersion);
    if (safeVersion.length !== 1) throw new Error(`无效模型版本: ${packageVersion}`);
    const modelRoot = await this.getModelRoot(create);
    if (!modelRoot) return null;
    let current = await getDirectory(modelRoot, packageVersion, create);
    if (!current) return null;
    const parts = assertSafePath(path);
    for (const part of parts.slice(0, -1)) {
      current = await getDirectory(current, part, create);
      if (!current) return null;
    }
    return current;
  }
}

export function createModelPackageReceipt(
  manifest: WebModelPackageManifest,
  installedAt = new Date().toISOString(),
): ModelPackageReceipt {
  return {
    schemaVersion: 1,
    packageVersion: manifest.version,
    installedAt,
    assets: manifest.assets.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
}

export function isReceiptForManifest(
  receipt: ModelPackageReceipt | null,
  manifest: WebModelPackageManifest,
): boolean {
  if (!receipt || receipt.packageVersion !== manifest.version) return false;
  if (receipt.assets.length !== manifest.assets.length) return false;
  return manifest.assets.every((asset) =>
    receipt.assets.some((stored) =>
      stored.path === asset.path
      && stored.size === asset.size
      && stored.sha256 === asset.sha256));
}

function isModelPackageReceipt(value: unknown): value is ModelPackageReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ModelPackageReceipt>;
  return (
    receipt.schemaVersion === 1
    && typeof receipt.packageVersion === 'string'
    && typeof receipt.installedAt === 'string'
    && Array.isArray(receipt.assets)
    && receipt.assets.every((asset) =>
      asset
      && typeof asset === 'object'
      && typeof asset.path === 'string'
      && typeof asset.size === 'number'
      && typeof asset.sha256 === 'string')
  );
}
