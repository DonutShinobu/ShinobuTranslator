import type {
  ExtensionBrowserApi,
  ExtensionMessageSender,
} from '../../shared/extensionRuntime';
import type {
  ContinuousTabStateCommand,
  ContinuousTabStateResult,
} from '../../shared/continuousTabState';

type StoredContinuousTabState = {
  origin: string;
  enabled: boolean;
};

function stateKey(tabId: number): string {
  return `mt:continuous-tab:${tabId}`;
}

function senderIdentity(sender: ExtensionMessageSender): { tabId: number; origin: string } {
  const tabId = sender.tab?.id;
  if (!Number.isSafeInteger(tabId) || (tabId ?? -1) < 0) {
    throw new Error('连续翻译状态请求缺少标签页身份');
  }
  const rawUrl = sender.origin
    ?? sender.documentUrl
    ?? sender.url
    ?? sender.tab?.url;
  if (!rawUrl) throw new Error('连续翻译状态请求缺少来源身份');
  const origin = new URL(rawUrl).origin;
  if (origin === 'null') throw new Error('连续翻译状态不支持不透明来源');
  return { tabId: tabId as number, origin };
}

function isStoredState(value: unknown): value is StoredContinuousTabState {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { origin?: unknown }).origin === 'string'
    && typeof (value as { enabled?: unknown }).enabled === 'boolean';
}

export class ContinuousTabStateService {
  constructor(private readonly api: ExtensionBrowserApi) {}

  async handle(
    command: ContinuousTabStateCommand,
    sender: ExtensionMessageSender,
  ): Promise<ContinuousTabStateResult> {
    const identity = senderIdentity(sender);
    if (command.operation === 'write') {
      if (command.enabled) {
        await this.set(identity.tabId, {
          origin: identity.origin,
          enabled: true,
        });
      } else {
        await this.clearTab(identity.tabId);
      }
      return { enabled: command.enabled };
    }

    const stored = await this.get(identity.tabId);
    if (!stored || stored.origin !== identity.origin) {
      if (stored) await this.clearTab(identity.tabId);
      return { enabled: false };
    }
    return { enabled: stored.enabled };
  }

  async clearTab(tabId: number): Promise<void> {
    const storageSession = this.api.storage?.session;
    if (!storageSession?.remove) throw new Error('浏览器不支持连续翻译标签页状态');
    await storageSession.remove(stateKey(tabId));
  }

  async handleNavigation(tabId: number, url: string): Promise<void> {
    let nextOrigin: string;
    try {
      nextOrigin = new URL(url).origin;
    } catch {
      await this.clearTab(tabId);
      return;
    }
    const stored = await this.get(tabId);
    if (stored && stored.origin !== nextOrigin) await this.clearTab(tabId);
  }

  private async get(tabId: number): Promise<StoredContinuousTabState | null> {
    const storageSession = this.api.storage?.session;
    if (!storageSession?.get) throw new Error('浏览器不支持连续翻译标签页状态');
    const key = stateKey(tabId);
    const value = (await storageSession.get(key))[key];
    return isStoredState(value) ? value : null;
  }

  private async set(tabId: number, state: StoredContinuousTabState): Promise<void> {
    const storageSession = this.api.storage?.session;
    if (!storageSession?.set) throw new Error('浏览器不支持连续翻译标签页状态');
    await storageSession.set({ [stateKey(tabId)]: state });
  }
}
