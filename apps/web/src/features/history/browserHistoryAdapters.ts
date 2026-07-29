import {
  type LocalHistoryAssetAdapter,
  type LocalHistoryBatch,
  type LocalHistoryCleanupRecord,
  type LocalHistoryIndexAdapter,
  type LocalHistoryIndexCommit,
} from './localHistory';

const DATABASE_NAME = 'shinobu-local-history';
const DATABASE_VERSION = 2;
const BATCH_STORE = 'batches';
const CLEANUP_STORE = 'cleanup-journal';
const APP_ROOT = 'shinobu-translator';
const HISTORY_ROOT = 'history-batches';

function cloneBatch(batch: LocalHistoryBatch): LocalHistoryBatch {
  return structuredClone(batch);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB 请求失败')), {
      once: true,
    });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB 事务已中止')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB 事务失败')),
      { once: true },
    );
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(BATCH_STORE)) {
      const store = database.createObjectStore(BATCH_STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    }
    if (!database.objectStoreNames.contains(CLEANUP_STORE)) {
      database.createObjectStore(CLEANUP_STORE, { keyPath: 'id' });
    }
  });
  return requestResult(request);
}

export class IndexedDbLocalHistoryIndexAdapter implements LocalHistoryIndexAdapter {
  constructor(
    private readonly databaseProvider: () => Promise<IDBDatabase> = openDatabase,
  ) {}

  async list(): Promise<LocalHistoryBatch[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(BATCH_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const batches = await requestResult(
      transaction.objectStore(BATCH_STORE).getAll() as IDBRequest<LocalHistoryBatch[]>,
    );
    await completed;
    return batches.map(cloneBatch);
  }

  async get(batchId: string): Promise<LocalHistoryBatch | null> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(BATCH_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const batch = await requestResult(
      transaction.objectStore(BATCH_STORE).get(batchId) as IDBRequest<
        LocalHistoryBatch | undefined
      >,
    );
    await completed;
    return batch ? cloneBatch(batch) : null;
  }

  async put(batch: LocalHistoryBatch): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(BATCH_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore(BATCH_STORE).put(cloneBatch(batch));
    await completed;
  }

  async delete(batchId: string): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(BATCH_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore(BATCH_STORE).delete(batchId);
    await completed;
  }

  async commit(input: LocalHistoryIndexCommit): Promise<void> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(
      [BATCH_STORE, CLEANUP_STORE],
      'readwrite',
    );
    const completed = transactionComplete(transaction);
    if (input.putBatch) {
      transaction.objectStore(BATCH_STORE).put(cloneBatch(input.putBatch));
    }
    if (input.deleteBatchId) {
      transaction.objectStore(BATCH_STORE).delete(input.deleteBatchId);
    }
    if (input.putCleanup) {
      transaction.objectStore(CLEANUP_STORE).put(structuredClone(input.putCleanup));
    }
    if (input.deleteCleanupId) {
      transaction.objectStore(CLEANUP_STORE).delete(input.deleteCleanupId);
    }
    await completed;
  }

  async listCleanup(): Promise<LocalHistoryCleanupRecord[]> {
    const database = await this.databaseProvider();
    const transaction = database.transaction(CLEANUP_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const records = await requestResult(
      transaction.objectStore(CLEANUP_STORE).getAll() as IDBRequest<
        LocalHistoryCleanupRecord[]
      >,
    );
    await completed;
    return records.map((record) => structuredClone(record));
  }
}

function safePathParts(path: string): string[] {
  const parts = path.split('/');
  if (
    parts.length < 2
    || parts.some((part) =>
      !part
      || part === '.'
      || part === '..'
      || part.includes('\\')
      || part.includes('\0'))
  ) {
    throw new Error(`无效历史资源路径: ${path}`);
  }
  return parts;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

async function directory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && isNotFound(error)) return null;
    throw error;
  }
}

async function historyRoot(
  storageRoot: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const app = await directory(storageRoot, APP_ROOT, create);
  return app ? directory(app, HISTORY_ROOT, create) : null;
}

async function parentForPath(
  storageRoot: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ parent: FileSystemDirectoryHandle; fileName: string } | null> {
  const parts = safePathParts(path);
  let current = await historyRoot(storageRoot, create);
  if (!current) return null;
  for (const part of parts.slice(0, -1)) {
    current = await directory(current, part, create);
    if (!current) return null;
  }
  return { parent: current, fileName: parts.at(-1)! };
}

export class OpfsLocalHistoryAssetAdapter implements LocalHistoryAssetAdapter {
  constructor(
    private readonly rootProvider: () => Promise<FileSystemDirectoryHandle> = () =>
      navigator.storage.getDirectory(),
  ) {}

  async put(path: string, blob: Blob): Promise<void> {
    const location = await parentForPath(await this.rootProvider(), path, true);
    if (!location) throw new Error('无法创建历史资源目录');
    const handle = await location.parent.getFileHandle(location.fileName, { create: true });
    const stream = await handle.createWritable();
    await stream.write(blob);
    await stream.close();
  }

  async get(path: string): Promise<Blob | null> {
    const location = await parentForPath(await this.rootProvider(), path, false);
    if (!location) return null;
    try {
      const handle = await location.parent.getFileHandle(location.fileName);
      return await handle.getFile();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    const location = await parentForPath(await this.rootProvider(), path, false);
    if (!location) return;
    try {
      await location.parent.removeEntry(location.fileName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteBatch(batchId: string): Promise<void> {
    const [safeBatchId] = safePathParts(`${batchId}/placeholder`);
    const root = await historyRoot(await this.rootProvider(), false);
    if (!root) return;
    try {
      await root.removeEntry(safeBatchId, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
