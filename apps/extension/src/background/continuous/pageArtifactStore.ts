import {
  PageArtifactQuotaError,
  type PageArtifactKind,
  type PageArtifactRef,
} from '../../shared/pageArtifacts';

export type { PageArtifactKind, PageArtifactRef } from '../../shared/pageArtifacts';

export type PutPageArtifactInput = {
  tabId: number;
  contentSessionId: string;
  kind: PageArtifactKind;
  file: File;
};

export type PageArtifactProbe =
  | { available: true }
  | { available: false; reason: string };

export interface PageArtifactStore {
  probe(): Promise<PageArtifactProbe>;
  put(input: PutPageArtifactInput): Promise<PageArtifactRef>;
  read(ref: PageArtifactRef): Promise<File>;
  delete(ref: PageArtifactRef): Promise<void>;
  clearContentSession(tabId: number, contentSessionId: string): Promise<void>;
  clearTab(tabId: number): Promise<void>;
  clearOrphanedContentSessions(activeByTab: ReadonlyMap<number, string>): Promise<void>;
}

function createArtifactId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function artifactKey(ref: Pick<PageArtifactRef, 'tabId' | 'contentSessionId' | 'id'>): string {
  return `${ref.tabId}:${ref.contentSessionId}:${ref.id}`;
}

function errorNameAndMessage(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

function assertSessionPath(tabId: number, contentSessionId: string): void {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('无效的标签页身份');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(contentSessionId)) {
    throw new Error('无效的内容会话身份');
  }
}

export class InMemoryPageArtifactStore implements PageArtifactStore {
  private readonly files = new Map<string, File>();

  async probe(): Promise<PageArtifactProbe> {
    return { available: true };
  }

  async put(input: PutPageArtifactInput): Promise<PageArtifactRef> {
    const ref: PageArtifactRef = {
      id: createArtifactId(),
      tabId: input.tabId,
      contentSessionId: input.contentSessionId,
      kind: input.kind,
      name: input.file.name,
      type: input.file.type,
      size: input.file.size,
    };
    this.files.set(artifactKey(ref), input.file);
    return ref;
  }

  async read(ref: PageArtifactRef): Promise<File> {
    const file = this.files.get(artifactKey(ref));
    if (!file) throw new Error('页面产物不存在');
    return file;
  }

  async delete(ref: PageArtifactRef): Promise<void> {
    this.files.delete(artifactKey(ref));
  }

  async clearContentSession(tabId: number, contentSessionId: string): Promise<void> {
    const prefix = `${tabId}:${contentSessionId}:`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async clearTab(tabId: number): Promise<void> {
    const prefix = `${tabId}:`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
  }

  async clearOrphanedContentSessions(activeByTab: ReadonlyMap<number, string>): Promise<void> {
    for (const key of this.files.keys()) {
      const [rawTabId, contentSessionId] = key.split(':', 3);
      const tabId = Number(rawTabId);
      if (activeByTab.get(tabId) !== contentSessionId) this.files.delete(key);
    }
  }
}

type OpfsPageArtifactStoreDependencies = {
  getRoot: () => Promise<FileSystemDirectoryHandle>;
  estimate?: () => Promise<StorageEstimate>;
  persist?: () => Promise<boolean>;
};

type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function defaultOpfsDependencies(): OpfsPageArtifactStoreDependencies {
  const storage = globalThis.navigator?.storage;
  return {
    getRoot: async () => {
      if (!storage || typeof storage.getDirectory !== 'function') {
        throw new DOMException('extension-origin OPFS is unavailable', 'NotSupportedError');
      }
      return storage.getDirectory();
    },
    estimate: storage?.estimate ? () => storage.estimate() : undefined,
    persist: storage?.persist ? () => storage.persist() : undefined,
  };
}

export class OpfsPageArtifactStore implements PageArtifactStore {
  private rootPromise: Promise<FileSystemDirectoryHandle> | undefined;

  constructor(
    private readonly dependencies: OpfsPageArtifactStoreDependencies = defaultOpfsDependencies(),
  ) {}

  async probe(): Promise<PageArtifactProbe> {
    let root: FileSystemDirectoryHandle | undefined;
    const probeName = '.mt-continuous-opfs-probe';
    try {
      root = await this.root();
      const probeHandle = await root.getFileHandle(probeName, { create: true });
      const writable = await probeHandle.createWritable();
      await writable.write(new Uint8Array());
      await writable.close();
      try {
        await this.dependencies.persist?.();
      } catch {
        // Persistence is best-effort and does not define OPFS availability.
      }
      return { available: true };
    } catch (error) {
      this.rootPromise = undefined;
      return { available: false, reason: errorNameAndMessage(error) };
    } finally {
      try {
        await root?.removeEntry(probeName);
      } catch {
        // Probe cleanup is best-effort, including when the capability write failed.
      }
    }
  }

  async put(input: PutPageArtifactInput): Promise<PageArtifactRef> {
    assertSessionPath(input.tabId, input.contentSessionId);
    await this.assertCapacity(input.file.size);
    const directory = await this.sessionDirectory(
      input.tabId,
      input.contentSessionId,
      true,
    );
    const id = createArtifactId();
    const temporaryName = `${id}.tmp`;
    const committedName = `${id}.bin`;
    try {
      const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
      const temporaryWritable = await temporaryHandle.createWritable();
      await temporaryWritable.write(input.file);
      await temporaryWritable.close();

      const committedHandle = await directory.getFileHandle(committedName, { create: true });
      const committedWritable = await committedHandle.createWritable();
      await committedWritable.write(await temporaryHandle.getFile());
      await committedWritable.close();
      try {
        await directory.removeEntry(temporaryName);
      } catch {
        // A committed artifact is valid even if best-effort temp cleanup failed.
      }
    } catch (error) {
      try {
        await directory.removeEntry(temporaryName);
      } catch {
        // A failed temporary write may not have created an entry.
      }
      try {
        await directory.removeEntry(committedName);
      } catch {
        // A failed commit may not have created an entry.
      }
      if (isQuotaError(error)) {
        throw new PageArtifactQuotaError(undefined, { cause: error });
      }
      throw error;
    }
    return {
      id,
      tabId: input.tabId,
      contentSessionId: input.contentSessionId,
      kind: input.kind,
      name: input.file.name,
      type: input.file.type,
      size: input.file.size,
    };
  }

  async read(ref: PageArtifactRef): Promise<File> {
    assertSessionPath(ref.tabId, ref.contentSessionId);
    try {
      const directory = await this.sessionDirectory(ref.tabId, ref.contentSessionId, false);
      const stored = await (await directory.getFileHandle(`${ref.id}.bin`)).getFile();
      return new File([stored], ref.name, { type: ref.type || stored.type });
    } catch (error) {
      if (isNotFound(error)) throw new Error('页面产物不存在', { cause: error });
      throw error;
    }
  }

  async delete(ref: PageArtifactRef): Promise<void> {
    assertSessionPath(ref.tabId, ref.contentSessionId);
    try {
      const directory = await this.sessionDirectory(ref.tabId, ref.contentSessionId, false);
      await directory.removeEntry(`${ref.id}.bin`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async clearContentSession(tabId: number, contentSessionId: string): Promise<void> {
    assertSessionPath(tabId, contentSessionId);
    try {
      const continuous = await (await this.root()).getDirectoryHandle('continuous');
      const tab = await continuous.getDirectoryHandle(`tab-${tabId}`);
      await tab.removeEntry(contentSessionId, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async clearTab(tabId: number): Promise<void> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('无效的标签页身份');
    try {
      const continuous = await (await this.root()).getDirectoryHandle('continuous');
      await continuous.removeEntry(`tab-${tabId}`, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async clearOrphanedContentSessions(activeByTab: ReadonlyMap<number, string>): Promise<void> {
    let continuous: FileSystemDirectoryHandle;
    try {
      continuous = await (await this.root()).getDirectoryHandle('continuous');
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for await (const [tabDirectoryName, handle] of this.entries(continuous)) {
      const match = /^tab-(\d+)$/u.exec(tabDirectoryName);
      if (handle.kind !== 'directory' || !match) continue;
      const tabId = Number(match[1]);
      const activeSessionId = activeByTab.get(tabId);
      if (!activeSessionId) {
        await continuous.removeEntry(tabDirectoryName, { recursive: true });
        continue;
      }
      const tabDirectory = handle as FileSystemDirectoryHandle;
      for await (const [sessionDirectoryName, sessionHandle] of this.entries(tabDirectory)) {
        if (sessionHandle.kind !== 'directory' || sessionDirectoryName === activeSessionId) continue;
        await tabDirectory.removeEntry(sessionDirectoryName, { recursive: true });
      }
    }
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= this.dependencies.getRoot();
    return this.rootPromise;
  }

  private entries(
    directory: FileSystemDirectoryHandle,
  ): AsyncIterableIterator<[string, FileSystemHandle]> {
    const entries = (directory as Partial<EnumerableDirectoryHandle>).entries;
    if (!entries) throw new Error('当前浏览器的页面产物存储不支持目录清理');
    return entries.call(directory);
  }

  private async sessionDirectory(
    tabId: number,
    contentSessionId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const continuous = await (await this.root()).getDirectoryHandle('continuous', { create });
    const tab = await continuous.getDirectoryHandle(`tab-${tabId}`, { create });
    return tab.getDirectoryHandle(contentSessionId, { create });
  }

  private async assertCapacity(requiredBytes: number): Promise<void> {
    if (!this.dependencies.estimate) return;
    const estimate = await this.dependencies.estimate();
    if (
      typeof estimate.quota === 'number'
      && typeof estimate.usage === 'number'
      && estimate.quota - estimate.usage < requiredBytes
    ) {
      throw new PageArtifactQuotaError();
    }
  }
}
