import {
  lockProcessingConfig,
  type LockedProcessingConfig,
  type WebSettings,
} from '@shinobu/shared-config';

export const LOCAL_HISTORY_SCHEMA_VERSION = 3 as const;
export type LocalHistorySchemaVersion = 1 | 2 | typeof LOCAL_HISTORY_SCHEMA_VERSION;

export type LocalHistoryBatchStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'partially-completed'
  | 'failed';
export type LocalHistoryItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type LocalHistoryVersions = {
  app: string;
  core: string;
  model: string;
  configSchema: number;
};

export type LocalHistoryAsset = {
  path: string;
  fileName: string;
  mediaType: string;
  size: number;
};

export type LocalHistoryItem = {
  id: string;
  order: number;
  width: number;
  height: number;
  workingCopy: {
    required: boolean;
    width: number;
    height: number;
    scale: number;
  };
  status: LocalHistoryItemStatus;
  original?: LocalHistoryAsset;
  thumbnail?: LocalHistoryAsset;
  result?: LocalHistoryAsset;
  summary?: unknown;
  error?: string;
};

export type LocalHistoryRecoveryPoint = {
  savedAt: string;
  nextItemIndex: number;
};

export type LocalHistoryBatch = {
  schemaVersion: LocalHistorySchemaVersion;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: LocalHistoryBatchStatus;
  rerunnable: boolean;
  lockedConfig: LockedProcessingConfig;
  versions: LocalHistoryVersions;
  recoveryPoint: LocalHistoryRecoveryPoint;
  items: LocalHistoryItem[];
};

export type LocalHistoryInspection = {
  batch: LocalHistoryBatch;
  integrity: 'complete' | 'partial';
  missingAssets: string[];
};

export type CreateLocalHistoryBatchInput = {
  id?: string;
  settings: WebSettings;
  versions: LocalHistoryVersions;
  items: CreateLocalHistoryItemInput[];
};

export type CreateLocalHistoryItemInput = {
  id: string;
  file: File;
  thumbnail?: Blob;
  width: number;
  height: number;
  workingCopy: LocalHistoryItem['workingCopy'];
};

export type UpdateLocalHistoryItemInput = {
  status: LocalHistoryItemStatus;
  result?: Blob;
  summary?: unknown;
  error?: string;
};

export type LocalHistoryCleanupOperation =
  | 'delete-batch'
  | 'keep-results-only'
  | 'remove-queued-item'
  | 'resume-batch'
  | 'staged-write';

export type LocalHistoryCleanupRecord = {
  id: string;
  batchId: string;
  operation: LocalHistoryCleanupOperation;
  createdAt: string;
  unreleasedBytes: number;
  target:
    | { type: 'batch' }
    | {
        type: 'assets';
        paths: string[];
      };
  lastAttemptAt?: string;
  error?: string;
};

export type LocalHistoryCleanupFault = Pick<
  LocalHistoryCleanupRecord,
  'id' | 'batchId' | 'operation' | 'createdAt' | 'unreleasedBytes' | 'lastAttemptAt' | 'error'
>;

export type LocalHistoryIndexCommit = {
  putBatch?: LocalHistoryBatch;
  deleteBatchId?: string;
  putCleanup?: LocalHistoryCleanupRecord;
  deleteCleanupId?: string;
};

export interface LocalHistoryIndexAdapter {
  list(): Promise<LocalHistoryBatch[]>;
  get(batchId: string): Promise<LocalHistoryBatch | null>;
  put(batch: LocalHistoryBatch): Promise<void>;
  delete(batchId: string): Promise<void>;
  commit(input: LocalHistoryIndexCommit): Promise<void>;
  listCleanup(): Promise<LocalHistoryCleanupRecord[]>;
}

export interface LocalHistoryAssetAdapter {
  put(path: string, blob: Blob): Promise<void>;
  get(path: string): Promise<Blob | null>;
  delete(path: string): Promise<void>;
  deleteBatch(batchId: string): Promise<void>;
}

export type LocalHistoryClock = {
  now(): Date;
};

export type LocalHistoryIdFactory = {
  create(): string;
};

const defaultClock: LocalHistoryClock = {
  now: () => new Date(),
};

const defaultIdFactory: LocalHistoryIdFactory = {
  create: () => crypto.randomUUID(),
};

function cloneBatch(batch: LocalHistoryBatch): LocalHistoryBatch {
  return structuredClone(batch);
}

function assetPath(batchId: string, order: number, kind: 'original' | 'thumbnail' | 'result'): string {
  return `${batchId}/items/${order}/${kind}`;
}

function itemAssetPath(
  batchId: string,
  item: LocalHistoryItem,
  kind: 'original' | 'thumbnail' | 'result',
): string {
  const anchor = item.original ?? item.thumbnail ?? item.result;
  if (anchor) return anchor.path.replace(/\/(original|thumbnail|result)$/u, `/${kind}`);
  return assetPath(batchId, item.order, kind);
}

function nextAssetSlot(batch: LocalHistoryBatch): number {
  let nextSlot = 0;
  for (const item of batch.items) {
    for (const reference of [item.original, item.thumbnail, item.result]) {
      const match = reference?.path.match(/\/items\/(\d+)\//u);
      if (match) nextSlot = Math.max(nextSlot, Number(match[1]) + 1);
    }
  }
  return nextSlot;
}

function requireBatch(
  batch: LocalHistoryBatch | null,
  batchId: string,
): asserts batch is LocalHistoryBatch {
  if (!batch) throw new Error(`找不到本地历史批次: ${batchId}`);
  migrateBatchSchema(batch);
}

function migrateBatchSchema(batch: LocalHistoryBatch): void {
  if (
    batch.schemaVersion !== 1
    && batch.schemaVersion !== 2
    && batch.schemaVersion !== LOCAL_HISTORY_SCHEMA_VERSION
  ) {
    throw new Error(`本地历史 Schema 版本不受支持: ${batch.schemaVersion}`);
  }
  const legacy = batch as LocalHistoryBatch & {
    lockedConfig?: LockedProcessingConfig;
    settings?: WebSettings;
  };
  if (!legacy.lockedConfig) {
    if (!legacy.settings) throw new Error('本地历史缺少锁定处理配置');
    legacy.lockedConfig = lockProcessingConfig(legacy.settings);
  }
  delete legacy.settings;
  batch.schemaVersion = LOCAL_HISTORY_SCHEMA_VERSION;
}

function requireItem(batch: LocalHistoryBatch, itemId: string): LocalHistoryItem {
  const item = batch.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到本地历史图片: ${itemId}`);
  return item;
}

function toAsset(path: string, fileName: string, blob: Blob): LocalHistoryAsset {
  return {
    path,
    fileName,
    mediaType: blob.type || 'application/octet-stream',
    size: blob.size,
  };
}

function resultFileName(originalName: string | undefined, itemId: string): string {
  const source = originalName?.trim() || itemId;
  const stem = source.replace(/\.[^.]+$/u, '');
  return `${stem || 'result'}.png`;
}

function cleanupId(
  operation: LocalHistoryCleanupOperation,
  batchId: string,
  timestamp: string,
): string {
  return `${operation}:${batchId}:${timestamp}`;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalHistory {
  constructor(
    private readonly index: LocalHistoryIndexAdapter,
    private readonly assets: LocalHistoryAssetAdapter,
    private readonly clock: LocalHistoryClock = defaultClock,
    private readonly ids: LocalHistoryIdFactory = defaultIdFactory,
  ) {}

  async list(): Promise<LocalHistoryBatch[]> {
    return (await this.index.list())
      .map((stored) => {
        const batch = cloneBatch(stored);
        migrateBatchSchema(batch);
        return batch;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(batchId: string): Promise<LocalHistoryBatch | null> {
    const stored = await this.index.get(batchId);
    if (!stored) return null;
    migrateBatchSchema(stored);
    return cloneBatch(stored);
  }

  async createBatch(input: CreateLocalHistoryBatchInput): Promise<LocalHistoryBatch> {
    const id = input.id ?? this.ids.create();
    const timestamp = this.clock.now().toISOString();
    const stagedWrite: LocalHistoryCleanupRecord = {
      id: cleanupId('staged-write', id, timestamp),
      batchId: id,
      operation: 'staged-write',
      createdAt: timestamp,
      unreleasedBytes: input.items.reduce(
        (total, item) => total + item.file.size + (item.thumbnail?.size ?? 0),
        0,
      ),
      target: { type: 'batch' },
    };
    await this.index.commit({ putCleanup: stagedWrite });
    const items: LocalHistoryItem[] = [];
    try {
      for (let order = 0; order < input.items.length; order += 1) {
        const source = input.items[order];
        const originalPath = assetPath(id, order, 'original');
        await this.assets.put(originalPath, source.file);
        const item: LocalHistoryItem = {
          id: source.id,
          order,
          width: source.width,
          height: source.height,
          workingCopy: structuredClone(source.workingCopy),
          status: 'queued',
          original: toAsset(originalPath, source.file.name, source.file),
        };
        if (source.thumbnail) {
          const thumbnailPath = assetPath(id, order, 'thumbnail');
          await this.assets.put(thumbnailPath, source.thumbnail);
          item.thumbnail = toAsset(
            thumbnailPath,
            `${source.file.name}.thumbnail`,
            source.thumbnail,
          );
        }
        items.push(item);
      }

      const batch: LocalHistoryBatch = {
        schemaVersion: LOCAL_HISTORY_SCHEMA_VERSION,
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'running',
        rerunnable: true,
        lockedConfig: lockProcessingConfig(input.settings),
        versions: structuredClone(input.versions),
        recoveryPoint: {
          savedAt: timestamp,
          nextItemIndex: 0,
        },
        items,
      };
      await this.index.commit({
        putBatch: batch,
        deleteCleanupId: stagedWrite.id,
      });
      return cloneBatch(batch);
    } catch (error) {
      await this.executeCleanup(stagedWrite);
      throw error;
    }
  }

  async updateItem(
    batchId: string,
    itemId: string,
    input: UpdateLocalHistoryItemInput,
  ): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    const item = requireItem(batch, itemId);

    if (input.result) {
      const path = itemAssetPath(batch.id, item, 'result');
      await this.assets.put(path, input.result);
      item.result = toAsset(
        path,
        resultFileName(item.original?.fileName, item.id),
        input.result,
      );
    }
    item.status = input.status;
    item.summary = input.summary === undefined ? item.summary : structuredClone(input.summary);
    item.error = input.error;
    batch.updatedAt = this.clock.now().toISOString();
    await this.index.put(batch);
    return cloneBatch(batch);
  }

  async appendItems(
    batchId: string,
    sources: readonly CreateLocalHistoryItemInput[],
  ): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    if (!batch.rerunnable) throw new Error('此历史记录只保留结果，不能追加图片');
    if (sources.length === 0) return cloneBatch(batch);

    const existingIds = new Set(batch.items.map((item) => item.id));
    const newIds = new Set<string>();
    for (const source of sources) {
      if (existingIds.has(source.id) || newIds.has(source.id)) {
        throw new Error(`历史批次包含重复图片 ID: ${source.id}`);
      }
      newIds.add(source.id);
    }

    const writtenPaths: string[] = [];
    const appended: LocalHistoryItem[] = [];
    let slot = nextAssetSlot(batch);
    try {
      for (const source of sources) {
        const originalPath = assetPath(batch.id, slot, 'original');
        await this.assets.put(originalPath, source.file);
        writtenPaths.push(originalPath);
        const item: LocalHistoryItem = {
          id: source.id,
          order: batch.items.length + appended.length,
          width: source.width,
          height: source.height,
          workingCopy: structuredClone(source.workingCopy),
          status: 'queued',
          original: toAsset(originalPath, source.file.name, source.file),
        };
        if (source.thumbnail) {
          const thumbnailPath = assetPath(batch.id, slot, 'thumbnail');
          await this.assets.put(thumbnailPath, source.thumbnail);
          writtenPaths.push(thumbnailPath);
          item.thumbnail = toAsset(
            thumbnailPath,
            `${source.file.name}.thumbnail`,
            source.thumbnail,
          );
        }
        appended.push(item);
        slot += 1;
      }

      batch.items.push(...appended);
      const timestamp = this.clock.now().toISOString();
      batch.updatedAt = timestamp;
      batch.recoveryPoint = {
        savedAt: timestamp,
        nextItemIndex: Math.max(
          0,
          batch.items.findIndex((item) => item.status === 'queued'),
        ),
      };
      await this.index.put(batch);
      return cloneBatch(batch);
    } catch (error) {
      await Promise.all(
        writtenPaths.map((path) => this.assets.delete(path).catch(() => undefined)),
      );
      throw error;
    }
  }

  async removeQueuedItem(batchId: string, itemId: string): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    const item = requireItem(batch, itemId);
    if (item.status !== 'queued') throw new Error('只能删除尚未开始的历史任务');

    const removable = [item.original, item.thumbnail, item.result].filter(
      (asset): asset is LocalHistoryAsset => Boolean(asset),
    );
    batch.items = batch.items.filter((candidate) => candidate.id !== itemId);
    batch.items.forEach((candidate, order) => {
      candidate.order = order;
    });
    const timestamp = this.clock.now().toISOString();
    batch.updatedAt = timestamp;
    const nextItemIndex = batch.items.findIndex((candidate) => candidate.status === 'queued');
    batch.recoveryPoint = {
      savedAt: timestamp,
      nextItemIndex: nextItemIndex < 0 ? batch.items.length : nextItemIndex,
    };
    await this.index.put(batch);
    await Promise.all(
      removable.map((asset) => this.assets.delete(asset.path).catch(() => undefined)),
    );
    return cloneBatch(batch);
  }

  async reorderQueuedItems(
    batchId: string,
    orderedItemIds: readonly string[],
  ): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    if (
      orderedItemIds.length !== batch.items.length
      || new Set(orderedItemIds).size !== batch.items.length
    ) {
      throw new Error('历史队列排序必须包含且仅包含当前批次的全部图片');
    }

    const byId = new Map(batch.items.map((item) => [item.id, item]));
    const reordered = orderedItemIds.map((id) => byId.get(id));
    if (reordered.some((item) => !item)) throw new Error('历史队列排序包含未知图片');
    for (let index = 0; index < batch.items.length; index += 1) {
      if (
        reordered[index]!.id !== batch.items[index].id
        && (reordered[index]!.status !== 'queued' || batch.items[index].status !== 'queued')
      ) {
        throw new Error('只能调整尚未开始任务之间的顺序');
      }
    }

    batch.items = reordered as LocalHistoryItem[];
    batch.items.forEach((item, order) => {
      item.order = order;
    });
    const timestamp = this.clock.now().toISOString();
    batch.updatedAt = timestamp;
    const nextItemIndex = batch.items.findIndex((item) => item.status === 'queued');
    batch.recoveryPoint = {
      savedAt: timestamp,
      nextItemIndex: nextItemIndex < 0 ? batch.items.length : nextItemIndex,
    };
    await this.index.put(batch);
    return cloneBatch(batch);
  }

  async saveRecoveryPoint(
    batchId: string,
    nextItemIndex: number,
    status: Extract<LocalHistoryBatchStatus, 'running' | 'paused'>,
  ): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    const timestamp = this.clock.now().toISOString();
    batch.status = status;
    batch.updatedAt = timestamp;
    batch.recoveryPoint = {
      savedAt: timestamp,
      nextItemIndex: Math.max(0, Math.min(nextItemIndex, batch.items.length)),
    };
    await this.index.put(batch);
    return cloneBatch(batch);
  }

  async finishBatch(
    batchId: string,
    status: Extract<
      LocalHistoryBatchStatus,
      'completed' | 'partially-completed' | 'failed' | 'paused'
    >,
  ): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    const timestamp = this.clock.now().toISOString();
    batch.status = status;
    batch.updatedAt = timestamp;
    batch.recoveryPoint = {
      savedAt: timestamp,
      nextItemIndex: batch.items.findIndex((item) => item.status === 'queued'),
    };
    if (batch.recoveryPoint.nextItemIndex < 0) {
      batch.recoveryPoint.nextItemIndex = batch.items.length;
    }
    await this.index.put(batch);
    return cloneBatch(batch);
  }

  async resumeBatch(batchId: string): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    if (!batch.rerunnable) throw new Error('此历史记录只保留结果，不能继续运行');

    const removableResults: LocalHistoryAsset[] = [];
    for (const item of batch.items) {
      if (item.status === 'done') {
        if (!item.result) throw new Error(`恢复批次已完成图片缺少结果: ${item.id}`);
        const result = await this.assets.get(item.result.path);
        if (!result || result.size !== item.result.size) {
          throw new Error(`恢复批次结果缺失或损坏: ${item.result.fileName}`);
        }
        continue;
      }
      if (item.status === 'failed' || item.status === 'cancelled') {
        continue;
      }
      if (!item.original) throw new Error(`恢复批次缺少原图: ${item.id}`);
      const original = await this.assets.get(item.original.path);
      if (!original || original.size !== item.original.size) {
        throw new Error(`恢复批次原图缺失或损坏: ${item.original.fileName}`);
      }
      if (item.result) removableResults.push(item.result);
      item.status = 'queued';
      item.result = undefined;
      item.summary = undefined;
      item.error = undefined;
    }

    const timestamp = this.clock.now().toISOString();
    const nextItemIndex = batch.items.findIndex((item) => item.status === 'queued');
    const completedCount = batch.items.filter((item) => item.status === 'done').length;
    batch.status = nextItemIndex >= 0
      ? 'running'
      : completedCount === batch.items.length
        ? 'completed'
        : completedCount > 0
          ? 'partially-completed'
          : 'failed';
    batch.updatedAt = timestamp;
    batch.recoveryPoint = {
      savedAt: timestamp,
      nextItemIndex: nextItemIndex < 0 ? batch.items.length : nextItemIndex,
    };
    await this.index.put(batch);
    await Promise.all(
      removableResults.map((asset) => this.assets.delete(asset.path).catch(() => undefined)),
    );
    return cloneBatch(batch);
  }

  async inspect(batchId: string): Promise<LocalHistoryInspection | null> {
    const batch = await this.index.get(batchId);
    if (!batch) return null;
    migrateBatchSchema(batch);
    const references = batch.items.flatMap((item) =>
      [item.original, item.thumbnail, item.result].filter(
        (asset): asset is LocalHistoryAsset => Boolean(asset),
      ));
    const missingAssets: string[] = [];
    for (const reference of references) {
      const blob = await this.assets.get(reference.path);
      if (!blob || blob.size !== reference.size) missingAssets.push(reference.path);
    }
    return {
      batch: cloneBatch(batch),
      integrity: missingAssets.length === 0 ? 'complete' : 'partial',
      missingAssets,
    };
  }

  async readAsset(reference: LocalHistoryAsset): Promise<Blob | null> {
    const blob = await this.assets.get(reference.path);
    return blob?.size === reference.size ? blob : null;
  }

  async listCleanupFaults(): Promise<LocalHistoryCleanupFault[]> {
    return (await this.index.listCleanup()).map((record) => {
      const {
        target: _target,
        ...fault
      } = structuredClone(record);
      return fault;
    });
  }

  async retryCleanup(batchId?: string): Promise<void> {
    for (const record of await this.index.listCleanup()) {
      if (batchId && record.batchId !== batchId) continue;
      await this.executeCleanup(record);
    }
  }

  private async executeCleanup(record: LocalHistoryCleanupRecord): Promise<void> {
    try {
      if (record.target.type === 'batch') {
        await this.assets.deleteBatch(record.batchId);
      } else {
        for (const path of record.target.paths) await this.assets.delete(path);
      }
      await this.index.commit({ deleteCleanupId: record.id });
    } catch (error) {
      await this.index.commit({
        putCleanup: {
          ...record,
          lastAttemptAt: this.clock.now().toISOString(),
          error: messageFor(error),
        },
      });
    }
  }

  async keepResultsOnly(batchId: string): Promise<LocalHistoryBatch> {
    const batch = await this.index.get(batchId);
    requireBatch(batch, batchId);
    const removable: LocalHistoryAsset[] = [];
    for (const item of batch.items) {
      removable.push(...[item.original, item.thumbnail].filter(
        (asset): asset is LocalHistoryAsset => Boolean(asset),
      ));
      item.original = undefined;
      item.thumbnail = undefined;
    }
    batch.rerunnable = false;
    const timestamp = this.clock.now().toISOString();
    batch.updatedAt = timestamp;
    const cleanup: LocalHistoryCleanupRecord = {
      id: cleanupId('keep-results-only', batch.id, timestamp),
      batchId: batch.id,
      operation: 'keep-results-only',
      createdAt: timestamp,
      unreleasedBytes: removable.reduce((total, asset) => total + asset.size, 0),
      target: {
        type: 'assets',
        paths: removable.map((asset) => asset.path),
      },
    };
    await this.index.commit({
      putBatch: batch,
      ...(removable.length > 0 ? { putCleanup: cleanup } : {}),
    });
    if (removable.length > 0) await this.executeCleanup(cleanup);
    return cloneBatch(batch);
  }

  async importBatch(
    source: LocalHistoryBatch,
    sourceAssets: ReadonlyMap<string, Blob>,
  ): Promise<LocalHistoryBatch> {
    const id = this.ids.create();
    const timestamp = this.clock.now().toISOString();
    const batch = cloneBatch(source);
    batch.schemaVersion = LOCAL_HISTORY_SCHEMA_VERSION;
    batch.id = id;
    batch.updatedAt = timestamp;
    batch.recoveryPoint.savedAt = timestamp;
    const stagedWrite: LocalHistoryCleanupRecord = {
      id: cleanupId('staged-write', id, timestamp),
      batchId: id,
      operation: 'staged-write',
      createdAt: timestamp,
      unreleasedBytes: Array.from(sourceAssets.values())
        .reduce((total, blob) => total + blob.size, 0),
      target: { type: 'batch' },
    };
    await this.index.commit({ putCleanup: stagedWrite });

    try {
      for (const item of batch.items) {
        for (const kind of ['original', 'thumbnail', 'result'] as const) {
          const reference = item[kind];
          if (!reference) continue;
          const blob = sourceAssets.get(reference.path);
          if (
            !blob
            || blob.size !== reference.size
            || (blob.type && blob.type !== reference.mediaType)
          ) {
            throw new Error(`项目包资源缺失或元数据不一致: ${reference.path}`);
          }
          const path = assetPath(id, item.order, kind);
          await this.assets.put(path, blob);
          item[kind] = {
            ...reference,
            path,
          };
        }
      }
      await this.index.commit({
        putBatch: batch,
        deleteCleanupId: stagedWrite.id,
      });
      return cloneBatch(batch);
    } catch (error) {
      await this.executeCleanup(stagedWrite);
      throw error;
    }
  }

  async deleteBatch(batchId: string): Promise<void> {
    const batch = await this.index.get(batchId);
    const timestamp = this.clock.now().toISOString();
    const cleanup: LocalHistoryCleanupRecord = {
      id: cleanupId('delete-batch', batchId, timestamp),
      batchId,
      operation: 'delete-batch',
      createdAt: timestamp,
      unreleasedBytes: batch?.items.reduce(
        (total, item) => total + [item.original, item.thumbnail, item.result].reduce(
          (itemTotal, asset) => itemTotal + (asset?.size ?? 0),
          0,
        ),
        0,
      ) ?? 0,
      target: { type: 'batch' },
    };
    await this.index.commit({
      deleteBatchId: batchId,
      putCleanup: cleanup,
    });
    await this.executeCleanup(cleanup);
  }
}

export class MemoryLocalHistoryIndexAdapter implements LocalHistoryIndexAdapter {
  private readonly batches = new Map<string, LocalHistoryBatch>();
  private readonly cleanup = new Map<string, LocalHistoryCleanupRecord>();

  async list(): Promise<LocalHistoryBatch[]> {
    return Array.from(this.batches.values(), cloneBatch);
  }

  async get(batchId: string): Promise<LocalHistoryBatch | null> {
    const batch = this.batches.get(batchId);
    return batch ? cloneBatch(batch) : null;
  }

  async put(batch: LocalHistoryBatch): Promise<void> {
    this.batches.set(batch.id, cloneBatch(batch));
  }

  async delete(batchId: string): Promise<void> {
    this.batches.delete(batchId);
  }

  async commit(input: LocalHistoryIndexCommit): Promise<void> {
    if (input.putBatch) this.batches.set(input.putBatch.id, cloneBatch(input.putBatch));
    if (input.deleteBatchId) this.batches.delete(input.deleteBatchId);
    if (input.putCleanup) {
      this.cleanup.set(input.putCleanup.id, structuredClone(input.putCleanup));
    }
    if (input.deleteCleanupId) this.cleanup.delete(input.deleteCleanupId);
  }

  async listCleanup(): Promise<LocalHistoryCleanupRecord[]> {
    return Array.from(this.cleanup.values(), (record) => structuredClone(record));
  }
}

export class MemoryLocalHistoryAssetAdapter implements LocalHistoryAssetAdapter {
  readonly blobs = new Map<string, Blob>();

  async put(path: string, blob: Blob): Promise<void> {
    this.blobs.set(path, blob.slice(0, blob.size, blob.type));
  }

  async get(path: string): Promise<Blob | null> {
    return this.blobs.get(path) ?? null;
  }

  async delete(path: string): Promise<void> {
    this.blobs.delete(path);
  }

  async deleteBatch(batchId: string): Promise<void> {
    for (const path of this.blobs.keys()) {
      if (path.startsWith(`${batchId}/`)) this.blobs.delete(path);
    }
  }
}
