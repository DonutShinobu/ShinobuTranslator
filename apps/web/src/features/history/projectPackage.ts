import {
  WEB_SETTINGS_SCHEMA_VERSION,
  decodeWebSettings,
} from '@shinobu/shared-config';
import {
  strToU8,
  unzipSync,
  zip,
  type AsyncZippable,
  type UnzipFileInfo,
} from 'fflate';
import {
  LOCAL_HISTORY_SCHEMA_VERSION,
  type LocalHistoryAsset,
  type LocalHistoryBatch,
  type LocalHistoryInspection,
} from './localHistory';
import { isWebPipelineRecord } from '../../domain/pipelineRecord';

export const PROJECT_PACKAGE_SCHEMA_VERSION = 1 as const;
export const PROJECT_PACKAGE_MAX_FILES = 301;
export const PROJECT_PACKAGE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PROJECT_PACKAGE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const PROJECT_PACKAGE_MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;

const PROJECT_FORMAT = 'shinobu-project';
const MANIFEST_PATH = 'manifest.json';
const allowedMediaTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
]);

export type ProjectPackageFile = {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
};

export type ProjectPackageManifest = {
  format: typeof PROJECT_FORMAT;
  schemaVersion: typeof PROJECT_PACKAGE_SCHEMA_VERSION;
  exportedAt: string;
  batch: LocalHistoryBatch;
  files: ProjectPackageFile[];
};

export type ValidatedProjectPackage = {
  manifest: ProjectPackageManifest;
  assets: Map<string, Blob>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeArchivePath(path: string): boolean {
  return (
    path === MANIFEST_PATH
    || /^assets\/\d+\/(?:original|thumbnail|result)\.(?:png|jpe?g|webp|avif)$/iu.test(path)
  ) && (
    !path.startsWith('/')
    && !path.includes('\\')
    && !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function assertSafeArchiveEntry(info: Pick<UnzipFileInfo, 'name' | 'originalSize'>): void {
  if (!isSafeArchivePath(info.name)) {
    throw new Error(`项目包包含不允许的路径或文件类型: ${info.name}`);
  }
  if (info.originalSize > PROJECT_PACKAGE_MAX_FILE_BYTES) {
    throw new Error(`项目包单文件超过上限: ${info.name}`);
  }
}

function archiveExtension(asset: LocalHistoryAsset): string {
  if (asset.mediaType === 'image/png') return 'png';
  if (asset.mediaType === 'image/jpeg') return 'jpg';
  if (asset.mediaType === 'image/webp') return 'webp';
  if (asset.mediaType === 'image/avif') return 'avif';
  throw new Error(`项目包不支持此资源类型: ${asset.mediaType}`);
}

function archiveAssetPath(
  order: number,
  kind: 'original' | 'thumbnail' | 'result',
  asset: LocalHistoryAsset,
): string {
  return `assets/${order}/${kind}.${archiveExtension(asset)}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function ownedBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

async function sha256(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBytes(data))));
}

function zipAsync(files: AsyncZippable): Promise<Blob> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') }, (error, archive) => {
      if (error) reject(error);
      else resolve(new Blob([archive], { type: 'application/zip' }));
    });
  });
}

function safeDownloadName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, '-')
    .replace(/^\.+/u, '')
    .trim();
  return cleaned || fallback;
}

function assertNoSecretKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretKeys);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[-_]?key|authorization|secret|token)$/iu.test(key)) {
      throw new Error(`项目包清单包含禁止的凭据字段: ${key}`);
    }
    assertNoSecretKeys(child);
  }
}

function isAsset(value: unknown): value is LocalHistoryAsset {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string'
    && typeof value.fileName === 'string'
    && typeof value.mediaType === 'string'
    && typeof value.size === 'number'
    && Number.isSafeInteger(value.size)
    && value.size >= 0
  );
}

function assertBatch(value: unknown): asserts value is LocalHistoryBatch {
  if (!isRecord(value)) throw new Error('项目包批次元数据无效');
  if (value.schemaVersion !== LOCAL_HISTORY_SCHEMA_VERSION) {
    throw new Error('项目包历史 Schema 版本不受支持');
  }
  if (
    typeof value.id !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.items)
    || !isRecord(value.settings)
    || !isRecord(value.versions)
    || !isRecord(value.recoveryPoint)
  ) {
    throw new Error('项目包批次元数据不完整');
  }
  if (
    !['running', 'paused', 'completed', 'failed'].includes(String(value.status))
    || typeof value.rerunnable !== 'boolean'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.versions.app !== 'string'
    || typeof value.versions.core !== 'string'
    || typeof value.versions.model !== 'string'
    || typeof value.versions.configSchema !== 'number'
    || typeof value.recoveryPoint.savedAt !== 'string'
    || !Number.isFinite(Date.parse(value.recoveryPoint.savedAt))
    || typeof value.recoveryPoint.nextItemIndex !== 'number'
    || !Number.isSafeInteger(value.recoveryPoint.nextItemIndex)
  ) {
    throw new Error('项目包批次状态或版本元数据无效');
  }
  if (
    typeof value.settings.schemaVersion !== 'number'
    || value.settings.schemaVersion > WEB_SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error('项目包配置 Schema 版本过新');
  }
  const decodedSettings = decodeWebSettings(
    JSON.stringify(value.settings),
    typeof value.settings.uiLocale === 'string' ? value.settings.uiLocale : undefined,
  );
  if (
    value.settings.schemaVersion === WEB_SETTINGS_SCHEMA_VERSION
    && decodedSettings.needsWrite
  ) {
    throw new Error('项目包配置与当前 Schema 不一致');
  }
  value.settings = decodedSettings.settings;
  if (value.items.length > 100) throw new Error('项目包图片数量超过上限');
  const itemIds = new Set<string>();
  const orders = new Set<number>();
  for (const item of value.items) {
    if (
      !isRecord(item)
      || typeof item.id !== 'string'
      || !item.id
      || typeof item.order !== 'number'
      || !Number.isSafeInteger(item.order)
      || item.order < 0
      || typeof item.width !== 'number'
      || !Number.isSafeInteger(item.width)
      || item.width <= 0
      || typeof item.height !== 'number'
      || !Number.isSafeInteger(item.height)
      || item.height <= 0
      || !['queued', 'running', 'done', 'failed', 'cancelled'].includes(String(item.status))
      || !isRecord(item.workingCopy)
      || typeof item.workingCopy.required !== 'boolean'
      || typeof item.workingCopy.width !== 'number'
      || typeof item.workingCopy.height !== 'number'
      || typeof item.workingCopy.scale !== 'number'
    ) {
      throw new Error('项目包图片元数据无效');
    }
    if (itemIds.has(item.id) || orders.has(item.order)) {
      throw new Error('项目包图片 ID 或顺序重复');
    }
    if (item.summary !== undefined && !isWebPipelineRecord(item.summary)) {
      throw new Error('项目包 OCR 或译文记录无效');
    }
    itemIds.add(item.id);
    orders.add(item.order);
    for (const kind of ['original', 'thumbnail', 'result'] as const) {
      if (item[kind] !== undefined && !isAsset(item[kind])) {
        throw new Error(`项目包图片资源元数据无效: ${kind}`);
      }
      const asset = item[kind];
      if (
        isAsset(asset)
        && (
          !allowedMediaTypes.has(asset.mediaType)
          || asset.size > PROJECT_PACKAGE_MAX_FILE_BYTES
          || !isSafeArchivePath(asset.path)
          || asset.path === MANIFEST_PATH
        )
      ) {
        throw new Error(`项目包图片资源类型或路径无效: ${kind}`);
      }
    }
  }
  if (
    value.recoveryPoint.nextItemIndex < 0
    || value.recoveryPoint.nextItemIndex > value.items.length
  ) {
    throw new Error('项目包恢复点超出图片范围');
  }
}

function parseManifest(data: Uint8Array): ProjectPackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch (error) {
    throw new Error('项目包 Manifest 不是有效的 UTF-8 JSON', { cause: error });
  }
  assertNoSecretKeys(value);
  if (!isRecord(value)) throw new Error('项目包 Manifest 无效');
  if (value.format !== PROJECT_FORMAT) throw new Error('不是 Shinobu 项目包');
  if (value.schemaVersion !== PROJECT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(
      typeof value.schemaVersion === 'number'
      && value.schemaVersion > PROJECT_PACKAGE_SCHEMA_VERSION
        ? '项目包版本过新，当前版本拒绝写入'
        : '项目包版本不受支持',
    );
  }
  if (
    typeof value.exportedAt !== 'string'
    || !Array.isArray(value.files)
  ) {
    throw new Error('项目包 Manifest 缺少版本或文件清单');
  }
  assertBatch(value.batch);
  const files: ProjectPackageFile[] = value.files.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.path !== 'string'
      || typeof entry.size !== 'number'
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || typeof entry.mediaType !== 'string'
      || !allowedMediaTypes.has(entry.mediaType)
      || !isSafeArchivePath(entry.path)
      || entry.path === MANIFEST_PATH
    ) {
      throw new Error('项目包文件声明无效');
    }
    return entry as ProjectPackageFile;
  });
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_PACKAGE_SCHEMA_VERSION,
    exportedAt: value.exportedAt,
    batch: value.batch,
    files,
  };
}

export async function buildResultsZip(
  inspection: LocalHistoryInspection,
  readAsset: (reference: LocalHistoryAsset) => Promise<Blob | null>,
): Promise<Blob> {
  const files: AsyncZippable = {};
  for (const item of [...inspection.batch.items].sort((left, right) => left.order - right.order)) {
    if (!item.result) continue;
    const blob = await readAsset(item.result);
    if (!blob) throw new Error(`结果文件缺失或损坏: ${item.result.fileName}`);
    const prefix = String(item.order + 1).padStart(3, '0');
    const name = safeDownloadName(item.result.fileName, `result-${prefix}.png`);
    files[`${prefix}-${name}`] = new Uint8Array(await blob.arrayBuffer());
  }
  if (Object.keys(files).length === 0) throw new Error('此批次没有可导出的结果');
  return zipAsync(files);
}

export async function buildProjectPackage(
  inspection: LocalHistoryInspection,
  readAsset: (reference: LocalHistoryAsset) => Promise<Blob | null>,
  exportedAt = new Date().toISOString(),
): Promise<Blob> {
  if (inspection.integrity !== 'complete') throw new Error('部分损坏的历史不能导出项目包');
  const batch = structuredClone(inspection.batch);
  const files: AsyncZippable = {};
  const declarations: ProjectPackageFile[] = [];

  for (const item of batch.items) {
    if (!isWebPipelineRecord(item.summary)) item.summary = undefined;
    for (const kind of ['original', 'thumbnail', 'result'] as const) {
      const reference = item[kind];
      if (!reference) continue;
      const blob = await readAsset(reference);
      if (!blob || blob.size !== reference.size) {
        throw new Error(`项目包资源缺失或损坏: ${reference.fileName}`);
      }
      const data = new Uint8Array(await blob.arrayBuffer());
      const path = archiveAssetPath(item.order, kind, reference);
      files[path] = data;
      declarations.push({
        path,
        size: data.byteLength,
        sha256: await sha256(data),
        mediaType: reference.mediaType,
      });
      item[kind] = {
        ...reference,
        path,
      };
    }
  }

  const manifest: ProjectPackageManifest = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_PACKAGE_SCHEMA_VERSION,
    exportedAt,
    batch,
    files: declarations,
  };
  assertNoSecretKeys(manifest);
  files[MANIFEST_PATH] = strToU8(JSON.stringify(manifest));
  return zipAsync(files);
}

export async function validateProjectPackage(blob: Blob): Promise<ValidatedProjectPackage> {
  if (blob.size > PROJECT_PACKAGE_MAX_ARCHIVE_BYTES) {
    throw new Error('项目包压缩文件超过导入上限');
  }
  const archive = new Uint8Array(await blob.arrayBuffer());
  let declaredTotal = 0;
  let fileCount = 0;
  const names = new Set<string>();
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(archive, {
      filter(info) {
        assertSafeArchiveEntry(info);
        if (names.has(info.name)) throw new Error(`项目包包含重复路径: ${info.name}`);
        names.add(info.name);
        fileCount += 1;
        if (fileCount > PROJECT_PACKAGE_MAX_FILES) throw new Error('项目包文件数量超过上限');
        declaredTotal += info.originalSize;
        if (declaredTotal > PROJECT_PACKAGE_MAX_TOTAL_BYTES) {
          throw new Error('项目包解压总量超过上限');
        }
        return true;
      },
    });
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`项目包解压失败: ${String(error)}`);
  }

  const manifestData = extracted[MANIFEST_PATH];
  if (!manifestData) throw new Error('项目包缺少 manifest.json');
  const manifest = parseManifest(manifestData);
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (declared.size !== manifest.files.length) throw new Error('项目包文件清单包含重复路径');

  const actualAssetPaths = Object.keys(extracted).filter((path) => path !== MANIFEST_PATH);
  if (
    actualAssetPaths.length !== declared.size
    || actualAssetPaths.some((path) => !declared.has(path))
  ) {
    throw new Error('项目包包含未声明文件或缺少已声明文件');
  }

  const referencedPaths = new Set<string>();
  for (const item of manifest.batch.items) {
    for (const kind of ['original', 'thumbnail', 'result'] as const) {
      const reference = item[kind];
      if (!reference) continue;
      referencedPaths.add(reference.path);
      const declaration = declared.get(reference.path);
      if (
        !declaration
        || declaration.size !== reference.size
        || declaration.mediaType !== reference.mediaType
      ) {
        throw new Error(`项目包资源引用与文件清单不一致: ${reference.path}`);
      }
    }
  }
  if (
    referencedPaths.size !== declared.size
    || manifest.files.some((entry) => !referencedPaths.has(entry.path))
  ) {
    throw new Error('项目包文件清单包含未引用资源');
  }

  const assets = new Map<string, Blob>();
  let actualTotal = 0;
  for (const declaration of manifest.files) {
    const data = extracted[declaration.path];
    actualTotal += data.byteLength;
    if (
      data.byteLength !== declaration.size
      || actualTotal > PROJECT_PACKAGE_MAX_TOTAL_BYTES
      || await sha256(data) !== declaration.sha256
    ) {
      throw new Error(`项目包资源大小或 SHA-256 校验失败: ${declaration.path}`);
    }
    assets.set(
      declaration.path,
      new Blob([ownedBytes(data)], { type: declaration.mediaType }),
    );
  }
  return { manifest, assets };
}
