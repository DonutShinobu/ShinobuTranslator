import {
  getExtensionApi,
  type ExtensionBrowserApi,
  type ExtensionMessageSender,
} from '../../shared/extensionRuntime';
import { isContentSessionId } from '../../shared/contentSession';
import { parseCredentiallessHttpsUrl } from '../../shared/restrictedResourceUrl';

// Keep page leases separate from the downloader's legacy/session rule IDs 1/2.
const firstRuleId = 10_000;
const lastRuleId = 10_999;
const leaseTimeoutMs = 35_000;

type Lease = {
  tabId: number;
  contentSessionId?: string;
  installation: Promise<void>;
  removal?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

function getTrustedTabId(sender: ExtensionMessageSender, contentSessionId?: string): number {
  const documentUrl = parseCredentiallessHttpsUrl(sender.documentUrl ?? sender.url ?? '');
  const tabId = sender.tab?.id;
  if (
    !documentUrl
    || (documentUrl.origin !== 'https://x.com' && documentUrl.origin !== 'https://twitter.com')
    || !Number.isSafeInteger(tabId)
    || typeof tabId !== 'number'
    || tabId < 0
    || (contentSessionId !== undefined && !isContentSessionId(contentSessionId))
  ) {
    throw new Error('无法确认图片缓存请求所属的 X 标签页');
  }
  return tabId;
}

function getImageUrl(value: string): string {
  const url = parseCredentiallessHttpsUrl(value);
  const sizes = url?.searchParams.getAll('name');
  if (
    !url
    || url.origin !== 'https://pbs.twimg.com'
    || !/^\/media\/[^/]+$/u.test(url.pathname)
    || url.hash
    || sizes?.length !== 1
  ) {
    throw new Error('图片缓存复用仅支持 X 的媒体图片');
  }
  return url.href;
}

export function createPageImageCache(options: {
  chromeApi?: ExtensionBrowserApi | null;
} = {}) {
  const chromeApi = options.chromeApi === undefined ? getExtensionApi() : options.chromeApi;
  const dnr = chromeApi?.declarativeNetRequest;
  const supported = chromeApi?.runtime?.getManifest?.().manifest_version === 3
    && dnr?.getSessionRules
    && dnr.updateSessionRules;
  const leases = new Map<number, Lease>();
  const endedSessions = new Set<string>();
  let nextRuleId = firstRuleId;

  // Session rules outlive a service worker, so remove leases left by its previous run.
  const initialization = supported ? (async () => {
    const rules = await dnr.getSessionRules!();
    const removeRuleIds = rules.map((rule) => rule.id)
      .filter((id) => Number.isSafeInteger(id) && id >= firstRuleId && id <= lastRuleId);
    if (removeRuleIds.length) {
      await dnr.updateSessionRules!({ removeRuleIds, addRules: [] });
    }
  })() : Promise.resolve();
  // Keep startup rejection available to prepare(), without an unhandled rejection.
  void initialization.catch(() => undefined);

  function requireSupport(): void {
    if (!supported) throw new Error('当前浏览器不支持页面图片缓存复用');
  }

  function allocateRuleId(): number {
    for (let count = firstRuleId; count <= lastRuleId; count += 1) {
      const id = nextRuleId;
      nextRuleId = id === lastRuleId ? firstRuleId : id + 1;
      if (!leases.has(id)) return id;
    }
    throw new Error('页面图片缓存请求过多');
  }

  function scheduleExpiry(ruleId: number, lease: Lease): void {
    // Timers run while the worker lives; startup/session cleanup covers suspension.
    if (lease.timer !== undefined) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      lease.timer = undefined;
      void removeLease(ruleId, lease).catch(() => undefined);
    }, leaseTimeoutMs);
  }

  function removeLease(ruleId: number, lease: Lease): Promise<void> {
    if (lease.removal) return lease.removal;
    lease.removal = (async () => {
      await lease.installation;
      await dnr!.updateSessionRules!({ removeRuleIds: [ruleId], addRules: [] });
      if (lease.timer !== undefined) clearTimeout(lease.timer);
      leases.delete(ruleId);
    })().catch((error: unknown) => {
      lease.removal = undefined;
      // A transient DNR failure must not lose the lease or its cleanup fallback.
      if (leases.get(ruleId) === lease) scheduleExpiry(ruleId, lease);
      throw error;
    });
    return lease.removal;
  }

  return {
    async prepare(imageUrl: string, sender: ExtensionMessageSender, contentSessionId?: string) {
      requireSupport();
      const tabId = getTrustedTabId(sender, contentSessionId);
      const url = getImageUrl(imageUrl);
      await initialization;
      if (contentSessionId && endedSessions.has(contentSessionId)) {
        throw new Error('图片缓存请求所属的内容会话已结束');
      }
      const ruleId = allocateRuleId();
      const installation = Promise.resolve().then(() => dnr!.updateSessionRules!({
        removeRuleIds: [],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Origin', operation: 'remove' }],
          },
          condition: {
            regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`,
            isUrlFilterCaseSensitive: true,
            tabIds: [tabId],
            initiatorDomains: ['x.com', 'twitter.com'],
            requestMethods: ['get'],
            resourceTypes: ['xmlhttprequest'],
          },
        }],
      }));
      const lease: Lease = { tabId, contentSessionId, installation };
      leases.set(ruleId, lease);
      try {
        await installation;
        if (!lease.removal) scheduleExpiry(ruleId, lease);
        return { ruleId };
      } catch (error) {
        leases.delete(ruleId);
        throw error;
      }
    },
    async release(ruleId: number, sender: ExtensionMessageSender, contentSessionId?: string) {
      requireSupport();
      const tabId = getTrustedTabId(sender, contentSessionId);
      if (!Number.isSafeInteger(ruleId) || ruleId < firstRuleId || ruleId > lastRuleId) {
        throw new Error('图片缓存租约无效');
      }
      await initialization;
      const lease = leases.get(ruleId);
      if (!lease) return;
      if (lease.tabId !== tabId || lease.contentSessionId !== contentSessionId) {
        throw new Error('图片缓存租约不属于当前标签页或内容会话');
      }
      await removeLease(ruleId, lease);
    },
    async cancelForSession(contentSessionId: string): Promise<void> {
      endedSessions.add(contentSessionId);
      await Promise.allSettled([...leases].filter(([, lease]) => (
        lease.contentSessionId === contentSessionId
      )).map(([ruleId, lease]) => removeLease(ruleId, lease)));
    },
  };
}
