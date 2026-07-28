export const IMAGE_IMPORT_STORAGE_HEADROOM_BYTES = 100 * 1024 * 1024;

export type WebStorageSnapshot =
  | {
      status: 'ready';
      usageBytes: number;
      quotaBytes: number;
      availableBytes: number;
      persisted: boolean;
    }
  | {
      status: 'unavailable';
      persisted: false;
      error: string;
    };

export type ImageImportStorageAssessment = {
  allowed: boolean;
  requiredBytes: number;
  availableBytes?: number;
  reason?: 'unavailable' | 'insufficient';
};

type StorageManagerLike = Partial<Pick<StorageManager, 'estimate' | 'persisted'>>;

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export async function inspectWebStorage(
  storageOverride?: StorageManagerLike,
): Promise<WebStorageSnapshot> {
  const storage = storageOverride ?? (
    typeof navigator === 'undefined' ? undefined : navigator.storage
  );
  if (!storage?.estimate) {
    return {
      status: 'unavailable',
      persisted: false,
      error: 'StorageManager.estimate is unavailable',
    };
  }

  let estimate: StorageEstimate;
  try {
    estimate = await storage.estimate();
  } catch (error) {
    return {
      status: 'unavailable',
      persisted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (typeof estimate.quota !== 'number' || !Number.isFinite(estimate.quota)) {
    return {
      status: 'unavailable',
      persisted: false,
      error: 'The browser did not report a storage quota',
    };
  }

  const quotaBytes = Math.max(0, estimate.quota);
  const usageBytes = Math.max(
    0,
    Math.min(
      quotaBytes,
      typeof estimate.usage === 'number' && Number.isFinite(estimate.usage)
        ? estimate.usage
        : 0,
    ),
  );
  let persisted = false;
  if (storage.persisted) {
    try {
      persisted = await storage.persisted();
    } catch {
      // Persistence status is informative and does not invalidate a usable quota.
    }
  }

  return {
    status: 'ready',
    usageBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - usageBytes),
    persisted,
  };
}

export function assessImageImportStorage(
  snapshot: WebStorageSnapshot,
  pendingOriginalBytes: number,
): ImageImportStorageAssessment {
  const normalizedOriginalBytes = Math.max(0, pendingOriginalBytes);
  const requiredBytes = (
    IMAGE_IMPORT_STORAGE_HEADROOM_BYTES
    + normalizedOriginalBytes * 2
  );

  if (snapshot.status !== 'ready') {
    return {
      allowed: false,
      requiredBytes,
      reason: 'unavailable',
    };
  }
  if (snapshot.availableBytes < requiredBytes) {
    return {
      allowed: false,
      requiredBytes,
      availableBytes: snapshot.availableBytes,
      reason: 'insufficient',
    };
  }
  return {
    allowed: true,
    requiredBytes,
    availableBytes: snapshot.availableBytes,
  };
}
