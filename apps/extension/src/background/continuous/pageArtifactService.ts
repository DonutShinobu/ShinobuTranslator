import type {
  ExtensionBrowserApi,
  ExtensionMessageSender,
} from '../../shared/extensionRuntime';
import type {
  PageArtifactCommand,
  PageArtifactCommandResult,
  PageArtifactRef,
  PageArtifactWireFile,
} from '../../shared/pageArtifacts';
import type { PageArtifactStore } from './pageArtifactStore';

export type ActiveContentSession = {
  tabId: number;
  contentSessionId: string;
  documentId: string;
};

export interface PageArtifactSessionIndex {
  read(): Promise<readonly ActiveContentSession[]>;
  write(sessions: readonly ActiveContentSession[]): Promise<void>;
}

const sessionIndexKey = 'mt:continuous-active-content-sessions';

function isActiveContentSession(value: unknown): value is ActiveContentSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.tabId)
    && (record.tabId as number) >= 0
    && typeof record.contentSessionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(record.contentSessionId)
    && typeof record.documentId === 'string'
    && record.documentId.length > 0;
}

export class InMemoryPageArtifactSessionIndex implements PageArtifactSessionIndex {
  private sessions: ActiveContentSession[] = [];

  async read(): Promise<readonly ActiveContentSession[]> {
    return this.sessions.map((session) => ({ ...session }));
  }

  async write(sessions: readonly ActiveContentSession[]): Promise<void> {
    this.sessions = sessions.map((session) => ({ ...session }));
  }
}

export class StorageSessionPageArtifactSessionIndex implements PageArtifactSessionIndex {
  constructor(private readonly api: ExtensionBrowserApi) {}

  async read(): Promise<readonly ActiveContentSession[]> {
    const get = this.api.storage?.session?.get;
    if (!get) throw new Error('浏览器不支持页面产物会话索引');
    const value = (await get(sessionIndexKey))[sessionIndexKey];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isActiveContentSession)) {
      throw new Error('页面产物会话索引已损坏');
    }
    return value;
  }

  async write(sessions: readonly ActiveContentSession[]): Promise<void> {
    const set = this.api.storage?.session?.set;
    if (!set) throw new Error('浏览器不支持页面产物会话索引');
    await set({ [sessionIndexKey]: sessions });
  }
}

function decodeWireFile(file: PageArtifactWireFile): File {
  const binary = atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], file.filename, { type: file.contentType });
}

async function encodeWireFile(file: File): Promise<PageArtifactWireFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return {
    base64: btoa(binary),
    contentType: file.type,
    filename: file.name,
  };
}

export class PageArtifactService {
  private readonly activeByTab = new Map<number, ActiveContentSession>();
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly store: PageArtifactStore,
    private readonly sessionIndex: PageArtifactSessionIndex = new InMemoryPageArtifactSessionIndex(),
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= this.restoreActiveSessions();
    return this.initialization;
  }

  async handle<C extends PageArtifactCommand>(
    command: C,
    sender: ExtensionMessageSender,
  ): Promise<PageArtifactCommandResult<C>> {
    await this.initialize();
    const identity = this.senderIdentity(sender);
    if (command.operation === 'probe') {
      const previous = this.activeByTab.get(identity.tabId);
      if (
        previous
        && (
          previous.contentSessionId !== command.contentSessionId
          || previous.documentId !== identity.documentId
        )
      ) {
        await this.store.clearContentSession(identity.tabId, previous.contentSessionId);
      }
      const probe = await this.store.probe();
      if (!probe.available) return probe as PageArtifactCommandResult<C>;
      this.activeByTab.set(identity.tabId, {
        tabId: identity.tabId,
        contentSessionId: command.contentSessionId,
        documentId: identity.documentId,
      });
      await this.persistActiveSessions();
      return probe as PageArtifactCommandResult<C>;
    }

    this.assertActive(identity.tabId, identity.documentId, command.contentSessionId);
    if (command.operation === 'put') {
      return await this.store.put({
        tabId: identity.tabId,
        contentSessionId: command.contentSessionId,
        kind: command.kind,
        file: decodeWireFile(command.file),
      }) as PageArtifactCommandResult<C>;
    }
    if (command.operation === 'read') {
      this.assertRef(command.ref, identity.tabId, command.contentSessionId);
      return await encodeWireFile(await this.store.read(command.ref)) as PageArtifactCommandResult<C>;
    }
    if (command.operation === 'delete') {
      this.assertRef(command.ref, identity.tabId, command.contentSessionId);
      await this.store.delete(command.ref);
      return { cleared: true } as PageArtifactCommandResult<C>;
    }

    await this.store.clearContentSession(identity.tabId, command.contentSessionId);
    this.activeByTab.delete(identity.tabId);
    await this.persistActiveSessions();
    return { cleared: true } as PageArtifactCommandResult<C>;
  }

  async closeContentSession(contentSessionId: string, knownTabId?: number): Promise<void> {
    await this.initialize();
    if (knownTabId !== undefined) {
      const active = this.activeByTab.get(knownTabId);
      if (active?.contentSessionId === contentSessionId) {
        this.activeByTab.delete(knownTabId);
        await this.persistActiveSessions();
      }
      await this.store.clearContentSession(knownTabId, contentSessionId);
      return;
    }
    let changed = false;
    for (const [tabId, active] of this.activeByTab) {
      if (active.contentSessionId !== contentSessionId) continue;
      this.activeByTab.delete(tabId);
      changed = true;
      await this.store.clearContentSession(tabId, contentSessionId);
    }
    if (changed) await this.persistActiveSessions();
  }

  async closeTab(tabId: number): Promise<void> {
    await this.initialize();
    this.activeByTab.delete(tabId);
    await this.persistActiveSessions();
    await this.store.clearTab(tabId);
  }

  private senderIdentity(sender: ExtensionMessageSender): { tabId: number; documentId: string } {
    const tabId = sender.tab?.id;
    if (!Number.isSafeInteger(tabId) || (tabId ?? -1) < 0 || !sender.documentId) {
      throw new Error('页面产物请求缺少可信发送方身份');
    }
    if (sender.frameId !== undefined && sender.frameId !== 0) {
      throw new Error('页面产物请求只允许顶层文档');
    }
    return { tabId: tabId as number, documentId: sender.documentId };
  }

  private assertActive(tabId: number, documentId: string, contentSessionId: string): void {
    const active = this.activeByTab.get(tabId);
    if (
      !active
      || active.contentSessionId !== contentSessionId
      || active.documentId !== documentId
    ) {
      throw new Error('内容会话与消息发送方不匹配');
    }
  }

  private assertRef(ref: PageArtifactRef, tabId: number, contentSessionId: string): void {
    if (ref.tabId !== tabId || ref.contentSessionId !== contentSessionId) {
      throw new Error('页面产物引用与内容会话不匹配');
    }
  }

  private async restoreActiveSessions(): Promise<void> {
    const sessions = await this.sessionIndex.read();
    this.activeByTab.clear();
    for (const session of sessions) this.activeByTab.set(session.tabId, session);
    await this.store.clearOrphanedContentSessions(new Map(
      sessions.map((session) => [session.tabId, session.contentSessionId]),
    ));
  }

  private persistActiveSessions(): Promise<void> {
    return this.sessionIndex.write([...this.activeByTab.values()]);
  }
}
