import { describe, expect, it, vi } from 'vitest';
import {
  ensureModelStorageCapacity,
  inspectModelPackage,
  installModelPackage,
  sha256Blob,
} from '../../apps/web/src/runtime/modelInstaller';
import type { WebModelPackageManifest } from '../../apps/web/src/runtime/modelPackage';
import {
  createModelPackageReceipt,
  type ModelAssetWriter,
  type ModelPackageReceipt,
  type ModelPackageStore,
} from '../../apps/web/src/runtime/modelPackageStore';
import { createInstalledModelAssetSource } from '../../apps/web/src/runtime/installedModelSource';

class MemoryModelPackageStore implements ModelPackageStore {
  readonly files = new Map<string, Uint8Array>();
  receipt: ModelPackageReceipt | null = null;

  key(version: string, path: string): string {
    return `${version}/${path}`;
  }

  async readCurrent(): Promise<ModelPackageReceipt | null> {
    return this.receipt;
  }

  async readAsset(version: string, path: string): Promise<Blob | null> {
    const value = this.files.get(this.key(version, path));
    if (!value) return null;
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return new Blob([copy]);
  }

  async openAssetWriter(
    version: string,
    path: string,
    offset: number,
  ): Promise<ModelAssetWriter> {
    const key = this.key(version, path);
    let data = this.files.get(key) ?? new Uint8Array();
    let position = offset;
    return {
      write: async (chunk) => {
        const required = position + chunk.byteLength;
        if (data.byteLength < required) {
          const expanded = new Uint8Array(required);
          expanded.set(data);
          data = expanded;
        }
        data.set(chunk, position);
        position = required;
        this.files.set(key, data);
      },
      close: async () => undefined,
    };
  }

  async clearAsset(version: string, path: string): Promise<void> {
    this.files.set(this.key(version, path), new Uint8Array());
  }

  async commit(receipt: ModelPackageReceipt): Promise<void> {
    this.receipt = receipt;
  }
}

async function manifestFor(
  entries: Array<{ id: string; path: string; url: string; content: string }>,
): Promise<WebModelPackageManifest> {
  return {
    schemaVersion: 1,
    version: 'test-v1',
    assets: await Promise.all(entries.map(async (entry) => {
      const blob = new Blob([entry.content]);
      return {
        id: entry.id,
        path: entry.path,
        url: entry.url,
        size: blob.size,
        sha256: await sha256Blob(blob),
      };
    })),
  };
}

function chunkedResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), init);
}

describe('Web model package installer', () => {
  it('downloads, verifies, and commits only after every asset succeeds', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'abc' },
      { id: 'two', path: 'two.bin', url: '/models/two.bin', content: 'defg' },
    ]);
    const store = new MemoryModelPackageStore();
    const progress: number[] = [];

    await installModelPackage({
      manifest,
      store,
      fetchImpl: vi.fn(async (input) => {
        const url = String(input);
        return new Response(url.endsWith('one.bin') ? 'abc' : 'defg');
      }) as typeof fetch,
      onProgress: (event) => progress.push(event.downloadedBytes),
    });

    expect(store.receipt).toEqual(createModelPackageReceipt(
      manifest,
      store.receipt?.installedAt,
    ));
    await expect(inspectModelPackage(store, manifest)).resolves.toEqual({
      installed: true,
      storedBytes: 7,
      totalBytes: 7,
    });
    expect(progress.at(-1)).toBe(7);
  });

  it('resumes a partial asset with a validated Range response', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'abcdef' },
    ]);
    const store = new MemoryModelPackageStore();
    store.files.set(store.key(manifest.version, 'one.bin'), new TextEncoder().encode('abc'));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=3-');
      return new Response('def', {
        status: 206,
        headers: { 'content-range': 'bytes 3-5/6' },
      });
    });

    await installModelPackage({
      manifest,
      store,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(await (await store.readAsset(manifest.version, 'one.bin'))?.text()).toBe('abcdef');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('restarts from zero when a server ignores Range', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'abcdef' },
    ]);
    const store = new MemoryModelPackageStore();
    store.files.set(store.key(manifest.version, 'one.bin'), new TextEncoder().encode('abc'));

    await installModelPackage({
      manifest,
      store,
      fetchImpl: vi.fn(async (_input, init) => {
        expect(new Headers(init?.headers).get('range')).toBe('bytes=3-');
        return new Response('abcdef', { status: 200 });
      }) as typeof fetch,
    });

    expect(await (await store.readAsset(manifest.version, 'one.bin'))?.text()).toBe('abcdef');
  });

  it('keeps verified progress resumable when cancellation occurs', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'abcdef' },
    ]);
    const store = new MemoryModelPackageStore();
    const controller = new AbortController();

    await expect(installModelPackage({
      manifest,
      store,
      signal: controller.signal,
      fetchImpl: vi.fn(async () => chunkedResponse(['abc', 'def'])) as typeof fetch,
      onProgress: (event) => {
        if (event.downloadedBytes === 3) controller.abort(
          new DOMException('cancelled', 'AbortError'),
        );
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(await (await store.readAsset(manifest.version, 'one.bin'))?.text()).toBe('abc');
    expect(store.receipt).toBeNull();
  });

  it('clears a corrupt asset and refuses to commit it', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'expected' },
    ]);
    const store = new MemoryModelPackageStore();

    await expect(installModelPackage({
      manifest,
      store,
      fetchImpl: vi.fn(async () => new Response('corrupt!')) as typeof fetch,
    })).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    });
    expect((await store.readAsset(manifest.version, 'one.bin'))?.size).toBe(0);
    expect(store.receipt).toBeNull();
  });

  it('blocks installation when the browser reports too little free space', async () => {
    const storage = {
      estimate: vi.fn(async () => ({ quota: 500 * 1024 * 1024, usage: 0 })),
      persist: vi.fn(async () => true),
    } as unknown as Pick<StorageManager, 'estimate' | 'persist'>;

    await expect(ensureModelStorageCapacity(storage)).rejects.toEqual(
      expect.objectContaining({
        code: 'INSUFFICIENT_STORAGE',
      }),
    );
    expect(storage.persist).not.toHaveBeenCalled();
  });
});

describe('installed model source Adapter', () => {
  it('maps manifest model paths to OPFS-backed object URLs', async () => {
    const manifest = await manifestFor([
      { id: 'one', path: 'one.bin', url: '/models/one.bin', content: 'abc' },
    ]);
    const store = new MemoryModelPackageStore();
    store.files.set(store.key(manifest.version, 'one.bin'), new TextEncoder().encode('abc'));
    store.receipt = createModelPackageReceipt(manifest);
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:model-one');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const installed = await createInstalledModelAssetSource(
      store,
      manifest,
      'https://app.example/workbench',
    );
    expect(installed.source.manifestUrl()).toBe('https://app.example/models/models.json');
    expect(installed.source.resolveAsset(
      '/models/one.bin',
      installed.source.manifestUrl(),
    )).toBe('blob:model-one');
    expect(installed.source.resolveAsset(
      '/models/other.bin',
      installed.source.manifestUrl(),
    )).toBe('https://app.example/models/other.bin');

    installed.dispose();
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:model-one');
  });

  it('maps canonical runtime paths when downloads use the production gateway', async () => {
    const manifest = await manifestFor([
      {
        id: 'one',
        path: 'one.bin',
        url: 'https://models.example/v1/models/hash/one.bin',
        content: 'abc',
      },
    ]);
    const store = new MemoryModelPackageStore();
    store.files.set(store.key(manifest.version, 'one.bin'), new TextEncoder().encode('abc'));
    store.receipt = createModelPackageReceipt(manifest);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:model-one');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const installed = await createInstalledModelAssetSource(
      store,
      manifest,
      'https://app.example/workbench',
    );

    expect(installed.source.resolveAsset(
      '/models/one.bin',
      installed.source.manifestUrl(),
    )).toBe('blob:model-one');
    installed.dispose();
  });
});
