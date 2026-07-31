import { describe, expect, it, vi } from 'vitest';
import {
  firefoxReferrerPolicyObserver,
  firefoxRequestHeaderOverride,
} from '../../../apps/extension/src/capabilities/firefoxNetwork';
import type {
  DocumentReferrerPolicy,
} from '../../../apps/extension/src/capabilities/contracts';
import type {
  FirefoxHeadersReceivedDetails,
} from '../../../apps/extension/src/capabilities/firefoxInternal';
import {
  runNetworkCapabilityContract,
} from './extensionAdapterContract.fixture';

type Rule = {
  id: number;
  [key: string]: unknown;
};

function createHeadersReceivedEvent() {
  const listeners = new Set<(details: FirefoxHeadersReceivedDetails) => void>();
  let removals = 0;
  let extraInfo: readonly string[] | undefined;
  return {
    raw: {
      addListener(
        listener: (details: FirefoxHeadersReceivedDetails) => void,
        _filter: unknown,
        values: readonly string[],
      ): void {
        listeners.add(listener);
        extraInfo = values;
      },
      removeListener(
        listener: (details: FirefoxHeadersReceivedDetails) => void,
      ): void {
        if (listeners.delete(listener)) removals += 1;
      },
    },
    emit(details: FirefoxHeadersReceivedDetails): void {
      for (const listener of listeners) listener(details);
    },
    removals: () => removals,
    extraInfo: () => extraInfo,
  };
}

function createDnrHarness(options: {
  sessionRules?: Rule[];
  dynamicRules?: Rule[];
} = {}) {
  let sessionRules = [...(options.sessionRules ?? [])];
  let dynamicRules = [...(options.dynamicRules ?? [])];
  let rejectedSessionUpdates = 0;
  let rejectedSessionReads = 0;
  const sessionUpdates: Array<{
    removeRuleIds: number[];
    addRules: Rule[];
  }> = [];
  const dynamicUpdates: Array<{
    removeRuleIds: number[];
    addRules: Rule[];
  }> = [];
  return {
    raw: {
      async getSessionRules(): Promise<Rule[]> {
        if (rejectedSessionReads > 0) {
          rejectedSessionReads -= 1;
          throw new Error('permission token=secret was revoked');
        }
        return sessionRules;
      },
      async getDynamicRules(): Promise<Rule[]> {
        return dynamicRules;
      },
      async updateSessionRules(update: {
        removeRuleIds: number[];
        addRules: Rule[];
      }): Promise<void> {
        sessionUpdates.push(update);
        if (rejectedSessionUpdates > 0) {
          rejectedSessionUpdates -= 1;
          throw new Error('permission token=secret was revoked');
        }
        sessionRules = sessionRules
          .filter((rule) => !update.removeRuleIds.includes(rule.id))
          .concat(update.addRules);
      },
      async updateDynamicRules(update: {
        removeRuleIds: number[];
        addRules: Rule[];
      }): Promise<void> {
        dynamicUpdates.push(update);
        dynamicRules = dynamicRules
          .filter((rule) => !update.removeRuleIds.includes(rule.id))
          .concat(update.addRules);
      },
    },
    sessionUpdates,
    dynamicUpdates,
    sessionRules: () => sessionRules,
    dynamicRules: () => dynamicRules,
    headersFor(request: {
      url: string;
      initiatorDomain: string;
    }): Record<string, string> {
      const headers: Record<string, string> = {};
      for (const rule of sessionRules) {
        const condition = rule.condition as {
          initiatorDomains?: string[];
          requestDomains?: string[];
          regexFilter?: string;
          urlFilter?: string;
        } | undefined;
        const action = rule.action as {
          requestHeaders?: Array<{
            header?: string;
            value?: string;
          }>;
        } | undefined;
        const target = new URL(request.url);
        const urlMatches = condition?.regexFilter
          ? new RegExp(condition.regexFilter, 'u').test(request.url)
          : condition?.urlFilter === request.url;
        if (
          !urlMatches
          || !condition?.initiatorDomains?.includes(request.initiatorDomain)
          || !condition.requestDomains?.includes(target.hostname)
        ) {
          continue;
        }
        for (const header of action?.requestHeaders ?? []) {
          if (header.header && header.value !== undefined) {
            headers[header.header.toLowerCase()] = header.value;
          }
        }
      }
      return headers;
    },
    rejectSessionUpdates(count = 1) {
      rejectedSessionUpdates += count;
    },
    rejectSessionReads(count = 1) {
      rejectedSessionReads += count;
    },
  };
}

function createNetworkContractDriver() {
  const event = createHeadersReceivedEvent();
  const dnr = createDnrHarness();
  const capabilities = {
    referrerPolicies: firefoxReferrerPolicyObserver(event.raw),
    requestHeaderOverride: firefoxRequestHeaderOverride(
      dnr.raw,
      'moz-extension://firefox-extension-uuid/',
    ),
  };
  return {
    capabilities,
    emitReferrerPolicy(observation: DocumentReferrerPolicy): void {
      event.emit({
        documentId: observation.document.documentId,
        tabId: observation.document.tabId,
        frameId: observation.document.frameId,
        url: observation.document.url,
        responseHeaders: observation.policy
          ? [{ name: 'Referrer-Policy', value: observation.policy }]
          : [],
      });
    },
    referrerListenerRemovals: event.removals,
    headerOverrideUpdateCount(): number {
      return dnr.sessionUpdates.filter((update) => (
        update.addRules.some((rule) => rule.id >= 1_000_000)
        || update.removeRuleIds.some((ruleId) => ruleId >= 1_000_000)
      )).length;
    },
    rejectNextHeaderOverrideUpdate(): void {
      dnr.rejectSessionUpdates();
    },
  };
}

describe('Firefox network capability adapter', () => {
  runNetworkCapabilityContract(createNetworkContractDriver);

  it('observes only native document identities and does not guess from a URL or tab', () => {
    const event = createHeadersReceivedEvent();
    const observer = firefoxReferrerPolicyObserver(event.raw);
    const observed = vi.fn();
    const cancel = observer.onObserved(observed);

    event.emit({
      tabId: 7,
      frameId: 0,
      url: 'https://reader.example/chapter/guessed',
      responseHeaders: [{
        name: 'Referrer-Policy',
        value: 'unsafe-url',
      }],
    });
    event.emit({
      documentId: 'firefox-document-7',
      tabId: 7,
      frameId: 0,
      url: 'https://reader.example/chapter/7',
      responseHeaders: [
        { name: 'Referrer-Policy', value: 'origin' },
        { name: 'referrer-policy', value: 'strict-origin' },
      ],
    });

    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({
      document: {
        documentId: 'firefox-document-7',
        tabId: 7,
        frameId: 0,
        url: 'https://reader.example/chapter/7',
      },
      policy: 'origin, strict-origin',
    });
    expect(event.extraInfo()).toEqual(['responseHeaders']);

    cancel();
    cancel();
    expect(event.removals()).toBe(1);
  });

  it('serializes concurrent leases and removes app-owned stale rules after host rebuild', async () => {
    const dnr = createDnrHarness({
      sessionRules: [
        { id: 42, priority: 1 },
        { id: 1_000_123, priority: 1 },
      ],
      dynamicRules: [{ id: 1, priority: 1 }],
    });
    const override = firefoxRequestHeaderOverride(
      dnr.raw,
      'moz-extension://firefox-extension-uuid/',
    );

    const first = await override.acquire({
      url: 'https://cdn.example/first.png',
      headers: [{ name: 'Referer', value: 'https://reader-a.example/' }],
    });
    const secondPromise = override.acquire({
      url: 'https://cdn.example/second.png',
      headers: [{ name: 'Referer', value: 'https://reader-b.example/' }],
    });

    await Promise.resolve();
    expect(dnr.sessionRules().filter((rule) => rule.id >= 1_000_000))
      .toHaveLength(1);
    expect(dnr.sessionRules()).not.toContainEqual(
      expect.objectContaining({ id: 1_000_123 }),
    );
    expect(dnr.dynamicRules()).not.toContainEqual(
      expect.objectContaining({ id: 1 }),
    );
    expect(dnr.headersFor({
      url: 'https://cdn.example/first.png',
      initiatorDomain: 'firefox-extension-uuid',
    })).toEqual({ referer: 'https://reader-a.example/' });
    expect(dnr.headersFor({
      url: 'https://cdn.example/first.png?other=request',
      initiatorDomain: 'firefox-extension-uuid',
    })).toEqual({});
    expect(dnr.headersFor({
      url: 'https://cdn.example/first.png',
      initiatorDomain: 'other-extension-uuid',
    })).toEqual({});

    await first.release();
    const second = await secondPromise;
    expect(dnr.headersFor({
      url: 'https://cdn.example/second.png',
      initiatorDomain: 'firefox-extension-uuid',
    })).toEqual({ referer: 'https://reader-b.example/' });

    await second.release();
    const updatesAfterRelease = dnr.sessionUpdates.length;
    await second.release();
    expect(dnr.sessionRules()).toEqual([{ id: 42, priority: 1 }]);
    expect(dnr.sessionUpdates).toHaveLength(updatesAfterRelease);
  });

  it('returns structured install, cleanup, revoked-permission, and rebuild failures', async () => {
    const installDnr = createDnrHarness();
    installDnr.rejectSessionUpdates();
    const installOverride = firefoxRequestHeaderOverride(
      installDnr.raw,
      'moz-extension://firefox-extension-uuid/',
    );
    await expect(installOverride.acquire({
      url: 'https://cdn.example/install.png',
      headers: [{ name: 'Referer', value: 'https://reader.example/' }],
    })).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'browser-rejected',
      retryable: false,
      diagnostic: { errorName: 'Error' },
    });

    const cleanupDnr = createDnrHarness();
    const cleanupOverride = firefoxRequestHeaderOverride(
      cleanupDnr.raw,
      'moz-extension://firefox-extension-uuid/',
    );
    const lease = await cleanupOverride.acquire({
      url: 'https://cdn.example/cleanup.png',
      headers: [{ name: 'Referer', value: 'https://reader.example/' }],
    });
    cleanupDnr.rejectSessionUpdates();
    await expect(lease.release()).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      operation: 'release',
      code: 'cleanup-failed',
      retryable: true,
    });
    await expect(lease.release()).resolves.toBeUndefined();

    const rebuiltDnr = createDnrHarness({
      sessionRules: [{ id: 1_000_099 }],
    });
    rebuiltDnr.rejectSessionReads(2);
    const rebuiltOverride = firefoxRequestHeaderOverride(
      rebuiltDnr.raw,
      'moz-extension://firefox-extension-uuid/',
    );
    const rebuiltAcquire = rebuiltOverride.acquire({
      url: 'https://cdn.example/rebuilt.png',
      headers: [{ name: 'Referer', value: 'https://reader.example/' }],
    });
    await expect(rebuiltAcquire).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      operation: 'acquire',
      code: 'cleanup-failed',
      retryable: true,
      diagnostic: { errorName: 'Error' },
    });
    await expect(rebuiltAcquire).rejects.not.toThrow('token=secret');
  });
});
