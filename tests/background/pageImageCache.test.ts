import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageImageCache } from '../../apps/extension/src/background/images/pageImageCache';
import type {
  ExtensionBrowserApi,
  ExtensionDnrRuleUpdate,
  ExtensionMessageSender,
} from '../../apps/extension/src/shared/extensionRuntime';

const imageUrl = 'https://pbs.twimg.com/media/Ab.c-123?format=jpg&name=large';
const sender: ExtensionMessageSender = {
  documentUrl: 'https://x.com/artist/status/123/photo/1',
  tab: { id: 7, url: 'https://x.com/artist/status/123/photo/1' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness(staleIds: number[] = []) {
  const getSessionRules = vi.fn(async () => staleIds.map((id) => ({ id })));
  const updateSessionRules = vi.fn(async (_update: ExtensionDnrRuleUpdate) => {});
  const api: ExtensionBrowserApi = {
    runtime: {
      getManifest: () => ({ version: 'test', manifest_version: 3 }),
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    declarativeNetRequest: { getSessionRules, updateSessionRules },
  };
  return { api, getSessionRules, updateSessionRules };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('page image cache leases', () => {
  it.each(['large', 'orig', '4096x4096', '2048x2048', 'medium', 'small', 'thumb', 'future-size'])('scopes Origin removal to the exact %s URL, tab, and page GET fetch', async (size) => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const displayedUrl = imageUrl.replace('name=large', `name=${size}`);
    const { ruleId } = await cache.prepare(displayedUrl, sender, 'session-1');
    const rule = h.updateSessionRules.mock.calls[0]?.[0].addRules[0];
    expect(ruleId).toBeGreaterThanOrEqual(10_000);
    expect(ruleId).toBeLessThanOrEqual(10_999);
    expect(rule).toEqual({
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Origin', operation: 'remove' }],
      },
      condition: {
        regexFilter: expect.any(String),
        isUrlFilterCaseSensitive: true,
        tabIds: [7],
        initiatorDomains: ['x.com', 'twitter.com'],
        requestMethods: ['get'],
        resourceTypes: ['xmlhttprequest'],
      },
    });
    const condition = rule?.condition as { regexFilter: string };
    const matching = new RegExp(condition.regexFilter);
    expect(matching.test(displayedUrl)).toBe(true);
    expect(matching.test(displayedUrl.replace('Ab.c', 'AbXc'))).toBe(false);
    expect(matching.test(displayedUrl.replace(`name=${size}`, `name=other-${size}`))).toBe(false);
    expect(matching.test(`${displayedUrl}&other=1`)).toBe(false);
    expect(matching.test(`https://evil.test/${displayedUrl}`)).toBe(false);
    await cache.release(ruleId, sender, 'session-1');
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ruleId], addRules: [] });
  });

  it('waits for startup cleanup and installation before declaring a lease ready', async () => {
    const h = createHarness();
    const scan = deferred<Array<{ id: number }>>();
    const cleanup = deferred<void>();
    const install = deferred<void>();
    h.getSessionRules.mockReturnValueOnce(scan.promise);
    h.updateSessionRules.mockReturnValueOnce(cleanup.promise).mockReturnValueOnce(install.promise);
    const cache = createPageImageCache({ chromeApi: h.api });
    let ready = false;
    const preparing = cache.prepare(imageUrl, sender).then((value) => { ready = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updateSessionRules).not.toHaveBeenCalled();
    scan.resolve([{ id: 1 }, { id: 2 }, { id: 10_000 }, { id: 10_999 }, { id: 11_000 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updateSessionRules).toHaveBeenCalledExactlyOnceWith({
      removeRuleIds: [10_000, 10_999], addRules: [],
    });
    expect(ready).toBe(false);
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(ready).toBe(false);
    // A slow installation cannot expire before the rule is actually installed.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    install.resolve();
    const { ruleId } = await preparing;
    expect(ready).toBe(true);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ruleId], addRules: [] });
  });

  it('allocates independent leases without putting later requests behind a delayed installation', async () => {
    const h = createHarness();
    const firstInstall = deferred<void>();
    h.updateSessionRules.mockReturnValueOnce(firstInstall.promise);
    const cache = createPageImageCache({ chromeApi: h.api });
    const first = cache.prepare(imageUrl, sender);
    await vi.advanceTimersByTimeAsync(0);
    const second = await cache.prepare(imageUrl, sender);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    const firstId = h.updateSessionRules.mock.calls[0]?.[0].addRules[0]?.id;
    expect(second.ruleId).not.toBe(firstId);
    await cache.release(second.ruleId, sender);
    firstInstall.resolve();
    const firstLease = await first;
    expect(firstLease.ruleId).toBe(firstId);
    await cache.release(firstLease.ruleId, sender);
  });

  it('does not install any new rules after startup scan or cleanup fails', async () => {
    const scanHarness = createHarness();
    scanHarness.getSessionRules.mockRejectedValueOnce(new Error('scan failed'));
    const scanned = createPageImageCache({ chromeApi: scanHarness.api });
    await expect(scanned.prepare(imageUrl, sender)).rejects.toThrow('scan failed');
    expect(scanHarness.updateSessionRules).not.toHaveBeenCalled();

    const cleanupHarness = createHarness([10_000]);
    cleanupHarness.updateSessionRules.mockRejectedValueOnce(new Error('cleanup failed'));
    const cleaned = createPageImageCache({ chromeApi: cleanupHarness.api });
    await expect(cleaned.prepare(imageUrl, sender)).rejects.toThrow('cleanup failed');
    await expect(cleaned.prepare(imageUrl, sender)).rejects.toThrow('cleanup failed');
    expect(cleanupHarness.updateSessionRules).toHaveBeenCalledTimes(1);
  });

  it('does not retain a failed installation or block subsequent requests', async () => {
    const h = createHarness();
    h.updateSessionRules.mockRejectedValueOnce(new Error('install failed'));
    const cache = createPageImageCache({ chromeApi: h.api });
    await expect(cache.prepare(imageUrl, sender)).rejects.toThrow('install failed');
    const failedId = h.updateSessionRules.mock.calls[0]?.[0].addRules[0]?.id as number;
    const successful = await cache.prepare(imageUrl, sender);
    await cache.release(failedId, sender);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(3);
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [successful.ruleId], addRules: [],
    });
  });

  it('makes release idempotent, waits for removal, and cancels its expiry', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const { ruleId } = await cache.prepare(imageUrl, sender);
    const removal = deferred<void>();
    h.updateSessionRules.mockReturnValueOnce(removal.promise);
    let done = false;
    const releasing = cache.release(ruleId, sender).then(() => { done = true; });
    const again = cache.release(ruleId, sender);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    removal.resolve();
    await Promise.all([releasing, again]);
    expect(done).toBe(true);
    await cache.release(ruleId, sender);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
  });

  it('keeps failed removals retryable and cleans them automatically', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const { ruleId } = await cache.prepare(imageUrl, sender);
    h.updateSessionRules.mockRejectedValueOnce(new Error('remove failed'));
    await expect(cache.release(ruleId, sender)).rejects.toThrow('remove failed');
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(3);
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ruleId], addRules: [] });
    await cache.release(ruleId, sender);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(3);
  });

  it('retries a failed automatic expiry without losing its lease', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const { ruleId } = await cache.prepare(imageUrl, sender);
    h.updateSessionRules.mockRejectedValueOnce(new Error('temporary failure'));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(3);
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ruleId], addRules: [] });
  });

  it('only releases a lease for its owner tab and content session', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const { ruleId } = await cache.prepare(imageUrl, sender, 'session-1');
    await expect(cache.release(ruleId, { ...sender, tab: { id: 8 } }, 'session-1')).rejects.toThrow('不属于');
    await expect(cache.release(ruleId, sender, 'session-2')).rejects.toThrow('不属于');
    await expect(cache.release(ruleId, sender)).rejects.toThrow('不属于');
    await expect(cache.release(2, sender, 'session-1')).rejects.toThrow('租约无效');
    await expect(cache.release(11_000, sender, 'session-1')).rejects.toThrow('租约无效');
    expect(h.updateSessionRules).toHaveBeenCalledTimes(1);
    await cache.release(ruleId, sender, 'session-1');
  });

  it('cleans a disconnected session even when its installation is still pending', async () => {
    const h = createHarness();
    const installation = deferred<void>();
    h.updateSessionRules.mockReturnValueOnce(installation.promise);
    const cache = createPageImageCache({ chromeApi: h.api });
    const preparing = cache.prepare(imageUrl, sender, 'session-1');
    await vi.advanceTimersByTimeAsync(0);
    const other = await cache.prepare(imageUrl, sender, 'session-2');
    const cancelling = cache.cancelForSession('session-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(2);
    installation.resolve();
    const ended = await preparing;
    await cancelling;
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ended.ruleId], addRules: [] });
    await expect(cache.prepare(imageUrl, sender, 'session-1')).rejects.toThrow('会话已结束');
    await cache.release(other.ruleId, sender, 'session-2');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.updateSessionRules).toHaveBeenCalledTimes(4);
  });

  it('does not install requests whose session disconnects during startup', async () => {
    const h = createHarness();
    const scan = deferred<Array<{ id: number }>>();
    h.getSessionRules.mockReturnValueOnce(scan.promise);
    const cache = createPageImageCache({ chromeApi: h.api });
    const preparing = cache.prepare(imageUrl, sender, 'session-1');
    const rejection = expect(preparing).rejects.toThrow('会话已结束');
    await cache.cancelForSession('session-1');
    scan.resolve([]);
    await rejection;
    expect(h.updateSessionRules).not.toHaveBeenCalled();
  });

  it('keeps session cancellation best-effort when DNR removal fails', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const lease = await cache.prepare(imageUrl, sender, 'session-1');
    h.updateSessionRules.mockRejectedValueOnce(new Error('remove failed'));
    await expect(cache.cancelForSession('session-1')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [lease.ruleId], addRules: [] });
  });

  it.each([
    { tab: { id: 7, url: 'https://x.com/' } },
    { ...sender, documentUrl: 'https://evil.test/', url: 'https://x.com/' },
    { ...sender, documentUrl: 'https://x.com.evil.test/' },
    { ...sender, documentUrl: 'https://x.com:8443/' },
    { ...sender, documentUrl: 'http://x.com/' },
    { ...sender, documentUrl: 'https://user:pass@x.com/' },
    { ...sender, tab: { id: -1 } },
    { ...sender, tab: { id: 1.5 } },
  ])('rejects untrusted document/tab metadata %j', async (untrusted) => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    await expect(cache.prepare(imageUrl, untrusted)).rejects.toThrow('X 标签页');
    expect(h.updateSessionRules).not.toHaveBeenCalled();
  });

  it.each([
    'http://pbs.twimg.com/media/a?name=large',
    'https://evil.test/media/a?name=large',
    'https://pbs.twimg.com.evil.test/media/a?name=large',
    'https://pbs.twimg.com/profile_images/a?name=large',
    'https://pbs.twimg.com/media/a',
    'https://pbs.twimg.com/media/a?name=large&name=orig',
    'https://pbs.twimg.com/media/a?name=large#fragment',
    'https://user:pass@pbs.twimg.com/media/a?name=large',
    'https://pbs.twimg.com:8443/media/a?name=large',
  ])('rejects images outside the cache scope: %s', async (url) => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    await expect(cache.prepare(url, sender)).rejects.toThrow('X 的媒体图片');
    expect(h.updateSessionRules).not.toHaveBeenCalled();
  });

  it('accepts Twitter sender.url and orig URLs but rejects malformed session IDs', async () => {
    const h = createHarness();
    const cache = createPageImageCache({ chromeApi: h.api });
    const twitter: ExtensionMessageSender = { url: 'https://twitter.com/artist', tab: { id: 0 } };
    const lease = await cache.prepare(imageUrl.replace('name=large', 'name=orig'), twitter);
    await cache.release(lease.ruleId, twitter);
    await expect(cache.prepare(imageUrl, sender, 'bad session')).rejects.toThrow('X 标签页');
  });

  it('reports missing capabilities and Firefox as unavailable without installing rules', async () => {
    const h = createHarness();
    const unsupported: Array<ExtensionBrowserApi | null> = [
      null,
      { ...h.api, runtime: { ...h.api.runtime, getManifest: () => ({ version: '', manifest_version: 2 }) } },
      { ...h.api, declarativeNetRequest: { updateSessionRules: h.updateSessionRules } },
      { ...h.api, declarativeNetRequest: { getSessionRules: h.getSessionRules } },
    ];
    for (const api of unsupported) {
      const cache = createPageImageCache({ chromeApi: api });
      await expect(cache.prepare(imageUrl, sender)).rejects.toThrow('不支持');
    }
    expect(h.getSessionRules).not.toHaveBeenCalled();
    expect(h.updateSessionRules).not.toHaveBeenCalled();
  });
});
