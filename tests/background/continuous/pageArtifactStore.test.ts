import { describe, expect, it } from 'vitest';
import {
  InMemoryPageArtifactStore,
  OpfsPageArtifactStore,
  type PageArtifactStore,
} from '../../../apps/extension/src/background/continuous/pageArtifactStore';

class FakeFileHandle {
  readonly kind = 'file';
  file: File | undefined;

  async createWritable() {
    return {
      write: async (value: Blob | ArrayBufferView<ArrayBuffer>) => {
        const blob = value instanceof Blob ? value : new Blob([value]);
        this.file = new File([await blob.arrayBuffer()], 'stored.bin', { type: blob.type });
      },
      close: async () => undefined,
    };
  }

  async getFile(): Promise<File> {
    if (!this.file) throw new DOMException('missing', 'NotFoundError');
    return this.file;
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory';
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  fileHandleRequests = 0;

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name);
    if (!directory && options?.create) {
      directory = new FakeDirectoryHandle();
      this.directories.set(name, directory);
    }
    if (!directory) throw new DOMException('missing', 'NotFoundError');
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    this.fileHandleRequests += 1;
    let file = this.files.get(name);
    if (!file && options?.create) {
      file = new FakeFileHandle();
      this.files.set(name, file);
    }
    if (!file) throw new DOMException('missing', 'NotFoundError');
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (directory && options?.recursive) {
      this.directories.delete(name);
      return;
    }
    throw new DOMException('missing', 'NotFoundError');
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [name, directory] of this.directories) {
      yield [name, directory as unknown as FileSystemDirectoryHandle];
    }
    for (const [name, file] of this.files) {
      yield [name, file as unknown as FileSystemFileHandle];
    }
  }
}

function runArtifactStoreContract(
  name: string,
  createStore: () => PageArtifactStore,
): void {
  describe(name, () => {
    it('writes, reads, deletes, and isolates both artifact kinds by content session', async () => {
      const store = createStore();
      await expect(store.probe()).resolves.toEqual({ available: true });
      const source = await store.put({
        tabId: 7,
        contentSessionId: 'session-a',
        kind: 'source-snapshot',
        file: new File(['source'], 'source.png', { type: 'image/png' }),
      });
      const result = await store.put({
        tabId: 7,
        contentSessionId: 'session-b',
        kind: 'translated-result',
        file: new File(['translated'], 'translated.png', { type: 'image/png' }),
      });

      await expect((await store.read(source)).text()).resolves.toBe('source');
      await expect((await store.read(result)).text()).resolves.toBe('translated');

      await store.clearContentSession(7, 'session-a');
      await expect(store.read(source)).rejects.toThrow('页面产物不存在');
      await expect((await store.read(result)).text()).resolves.toBe('translated');

      await store.delete(result);
      await expect(store.read(result)).rejects.toThrow('页面产物不存在');
    });

    it('removes content sessions absent from the persisted active index', async () => {
      const store = createStore();
      const active = await store.put({
        tabId: 7,
        contentSessionId: 'session-active',
        kind: 'source-snapshot',
        file: new File(['active'], 'active.png'),
      });
      const staleDocument = await store.put({
        tabId: 7,
        contentSessionId: 'session-stale',
        kind: 'source-snapshot',
        file: new File(['stale'], 'stale.png'),
      });
      const staleTab = await store.put({
        tabId: 8,
        contentSessionId: 'session-other',
        kind: 'source-snapshot',
        file: new File(['other'], 'other.png'),
      });

      await store.clearOrphanedContentSessions(new Map([[7, 'session-active']]));

      await expect((await store.read(active)).text()).resolves.toBe('active');
      await expect(store.read(staleDocument)).rejects.toThrow('页面产物不存在');
      await expect(store.read(staleTab)).rejects.toThrow('页面产物不存在');
    });
  });
}

runArtifactStoreContract('in-memory PageArtifactStore contract', () => (
  new InMemoryPageArtifactStore()
));

runArtifactStoreContract('OPFS PageArtifactStore contract', () => (
  new OpfsPageArtifactStore({
    getRoot: async () => new FakeDirectoryHandle() as unknown as FileSystemDirectoryHandle,
    estimate: async () => ({ quota: 1024 * 1024, usage: 0 }),
    persist: async () => true,
  })
));

describe('OPFS PageArtifactStore capability', () => {
  it('probes an actual write and removes the probe artifact', async () => {
    const root = new FakeDirectoryHandle();
    const store = new OpfsPageArtifactStore({
      getRoot: async () => root as unknown as FileSystemDirectoryHandle,
    });

    await expect(store.probe()).resolves.toEqual({ available: true });
    expect(root.fileHandleRequests).toBeGreaterThan(0);
    expect(root.files.size).toBe(0);
  });

  it('reports an unavailable extension-origin filesystem without falling back to memory', async () => {
    const store = new OpfsPageArtifactStore({
      getRoot: async () => {
        throw new DOMException('disabled', 'NotSupportedError');
      },
    });

    await expect(store.probe()).resolves.toEqual({
      available: false,
      reason: 'NotSupportedError: disabled',
    });
  });

  it('removes the probe artifact when the capability write fails', async () => {
    const root = new FakeDirectoryHandle();
    root.files.set('.mt-continuous-opfs-probe', {
      createWritable: async () => ({
        write: async () => {
          throw new DOMException('blocked', 'NotAllowedError');
        },
        close: async () => undefined,
      }),
    } as unknown as FakeFileHandle);
    const store = new OpfsPageArtifactStore({
      getRoot: async () => root as unknown as FileSystemDirectoryHandle,
    });

    await expect(store.probe()).resolves.toEqual({
      available: false,
      reason: 'NotAllowedError: blocked',
    });
    expect(root.files.size).toBe(0);
  });
});
