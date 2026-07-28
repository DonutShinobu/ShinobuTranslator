import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_IMPORT_STORAGE_HEADROOM_BYTES,
  assessImageImportStorage,
  formatByteSize,
  inspectWebStorage,
  type WebStorageSnapshot,
} from '../../apps/web/src/features/storage/storageBudget';

describe('Web storage budget', () => {
  it('reports usage, remaining quota, and persistence without requesting persistence', async () => {
    const storage = {
      estimate: vi.fn(async () => ({
        quota: 2 * 1024 * 1024 * 1024,
        usage: 512 * 1024 * 1024,
      })),
      persisted: vi.fn(async () => true),
    };

    await expect(inspectWebStorage(storage)).resolves.toEqual({
      status: 'ready',
      usageBytes: 512 * 1024 * 1024,
      quotaBytes: 2 * 1024 * 1024 * 1024,
      availableBytes: 1536 * 1024 * 1024,
      persisted: true,
    });
    expect(storage.estimate).toHaveBeenCalledOnce();
    expect(storage.persisted).toHaveBeenCalledOnce();
  });

  it('fails closed when quota inspection is unavailable or incomplete', async () => {
    await expect(inspectWebStorage({})).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    );
    await expect(inspectWebStorage({
      estimate: vi.fn(async () => ({ usage: 10 })),
    })).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    );
  });

  it('reserves room for originals, generated results, and fixed headroom', () => {
    const incomingBytes = 40 * 1024 * 1024;
    const requiredBytes = IMAGE_IMPORT_STORAGE_HEADROOM_BYTES + incomingBytes * 2;
    const ready: WebStorageSnapshot = {
      status: 'ready',
      usageBytes: 0,
      quotaBytes: requiredBytes,
      availableBytes: requiredBytes,
      persisted: false,
    };

    expect(assessImageImportStorage(ready, incomingBytes)).toEqual({
      allowed: true,
      requiredBytes,
      availableBytes: requiredBytes,
    });
    expect(assessImageImportStorage({
      ...ready,
      quotaBytes: requiredBytes - 1,
      availableBytes: requiredBytes - 1,
    }, incomingBytes)).toEqual({
      allowed: false,
      requiredBytes,
      availableBytes: requiredBytes - 1,
      reason: 'insufficient',
    });
  });

  it('blocks imports when remaining storage cannot be verified', () => {
    expect(assessImageImportStorage({
      status: 'unavailable',
      persisted: false,
      error: 'denied',
    }, 1)).toEqual({
      allowed: false,
      requiredBytes: IMAGE_IMPORT_STORAGE_HEADROOM_BYTES + 2,
      reason: 'unavailable',
    });
  });

  it('formats storage values consistently', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1536)).toBe('1.5 KiB');
    expect(formatByteSize(20 * 1024 * 1024)).toBe('20 MiB');
  });
});
