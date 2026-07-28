import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  IndexedDbLocalHistoryIndexAdapter,
  OpfsLocalHistoryAssetAdapter,
} from './browserHistoryAdapters';
import {
  LocalHistory,
  type CreateLocalHistoryBatchInput,
  type CreateLocalHistoryItemInput,
  type LocalHistoryAsset,
  type LocalHistoryBatch,
  type LocalHistoryBatchStatus,
  type LocalHistoryInspection,
  type UpdateLocalHistoryItemInput,
} from './localHistory';

type UseLocalHistory = {
  entries: LocalHistoryInspection[];
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
  createBatch(input: CreateLocalHistoryBatchInput): Promise<LocalHistoryBatch>;
  updateItem(
    batchId: string,
    itemId: string,
    input: UpdateLocalHistoryItemInput,
  ): Promise<LocalHistoryBatch>;
  appendItems(
    batchId: string,
    items: readonly CreateLocalHistoryItemInput[],
  ): Promise<LocalHistoryBatch>;
  removeQueuedItem(batchId: string, itemId: string): Promise<LocalHistoryBatch>;
  reorderQueuedItems(
    batchId: string,
    orderedItemIds: readonly string[],
  ): Promise<LocalHistoryBatch>;
  saveRecoveryPoint(
    batchId: string,
    nextItemIndex: number,
    status: Extract<LocalHistoryBatchStatus, 'running' | 'paused'>,
  ): Promise<LocalHistoryBatch>;
  finishBatch(
    batchId: string,
    status: Extract<LocalHistoryBatchStatus, 'completed' | 'failed' | 'paused'>,
  ): Promise<LocalHistoryBatch>;
  resumeBatch(batchId: string): Promise<LocalHistoryBatch>;
  importBatch(
    source: LocalHistoryBatch,
    assets: ReadonlyMap<string, Blob>,
  ): Promise<LocalHistoryBatch>;
  keepResultsOnly(batchId: string): Promise<LocalHistoryBatch>;
  deleteBatch(batchId: string): Promise<void>;
  readAsset(reference: LocalHistoryAsset): Promise<Blob | null>;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLocalHistory(): UseLocalHistory {
  const history = useMemo(
    () => new LocalHistory(
      new IndexedDbLocalHistoryIndexAdapter(),
      new OpfsLocalHistoryAssetAdapter(),
    ),
    [],
  );
  const [entries, setEntries] = useState<LocalHistoryInspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const upsert = useCallback((batch: LocalHistoryBatch): void => {
    setEntries((current) => {
      const previous = current.find((entry) => entry.batch.id === batch.id);
      return [
        {
          batch,
          integrity: previous?.integrity ?? 'complete',
          missingAssets: previous?.missingAssets ?? [],
        },
        ...current.filter((entry) => entry.batch.id !== batch.id),
      ].sort((left, right) =>
        right.batch.updatedAt.localeCompare(left.batch.updatedAt));
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const batches = await history.list();
      const inspected = await Promise.all(
        batches.map((batch) => history.inspect(batch.id)),
      );
      setEntries(
        inspected.filter((entry): entry is LocalHistoryInspection => entry !== null),
      );
      setError(undefined);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  }, [history]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBatch = useCallback(async (
    input: CreateLocalHistoryBatchInput,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.createBatch(input);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const updateItem = useCallback(async (
    batchId: string,
    itemId: string,
    input: UpdateLocalHistoryItemInput,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.updateItem(batchId, itemId, input);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const appendItems = useCallback(async (
    batchId: string,
    items: readonly CreateLocalHistoryItemInput[],
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.appendItems(batchId, items);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const removeQueuedItem = useCallback(async (
    batchId: string,
    itemId: string,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.removeQueuedItem(batchId, itemId);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const reorderQueuedItems = useCallback(async (
    batchId: string,
    orderedItemIds: readonly string[],
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.reorderQueuedItems(batchId, orderedItemIds);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const saveRecoveryPoint = useCallback(async (
    batchId: string,
    nextItemIndex: number,
    status: Extract<LocalHistoryBatchStatus, 'running' | 'paused'>,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.saveRecoveryPoint(batchId, nextItemIndex, status);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const finishBatch = useCallback(async (
    batchId: string,
    status: Extract<LocalHistoryBatchStatus, 'completed' | 'failed' | 'paused'>,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.finishBatch(batchId, status);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const readAsset = useCallback(
    (reference: LocalHistoryAsset) => history.readAsset(reference),
    [history],
  );

  const importBatch = useCallback(async (
    source: LocalHistoryBatch,
    assets: ReadonlyMap<string, Blob>,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.importBatch(source, assets);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const resumeBatch = useCallback(async (batchId: string): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.resumeBatch(batchId);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const keepResultsOnly = useCallback(async (
    batchId: string,
  ): Promise<LocalHistoryBatch> => {
    try {
      const batch = await history.keepResultsOnly(batchId);
      upsert(batch);
      setError(undefined);
      return batch;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history, upsert]);

  const deleteBatch = useCallback(async (batchId: string): Promise<void> => {
    try {
      await history.deleteBatch(batchId);
      setEntries((current) =>
        current.filter((entry) => entry.batch.id !== batchId));
      setError(undefined);
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, [history]);

  return {
    entries,
    loading,
    error,
    refresh,
    createBatch,
    updateItem,
    appendItems,
    removeQueuedItem,
    reorderQueuedItems,
    saveRecoveryPoint,
    finishBatch,
    resumeBatch,
    importBatch,
    keepResultsOnly,
    deleteBatch,
    readAsset,
  };
}
