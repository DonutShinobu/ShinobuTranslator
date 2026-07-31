import type {
  DocumentReferrerPolicyObserver,
  RequestHeaderOverride,
} from './contracts';
import {
  ExtensionContractError,
} from './errors';
import {
  idempotentCancel,
  operationFailure,
  requireFunction,
  requireNamespace,
} from './adapterInternal';
import type {
  FirefoxDeclarativeNetRequest,
  FirefoxDeclarativeNetRequestRule,
  FirefoxHeadersReceivedDetails,
  FirefoxHeadersReceivedEvent,
} from './firefoxInternal';
import { coordinatedRequestHeaderOverride } from './requestHeaderOverride';

const legacyDynamicHeaderOverrideRuleId = 1;
const legacySessionHeaderOverrideRuleId = 2;
const firstHeaderOverrideRuleId = 1_000_000;
const lastHeaderOverrideRuleId = 1_999_999;

function isAppOwnedRule(rule: FirefoxDeclarativeNetRequestRule): boolean {
  return rule.id >= firstHeaderOverrideRuleId
    && rule.id <= lastHeaderOverrideRuleId;
}

function exactUrlRegex(url: string): string {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`;
}

function extensionInitiatorDomain(extensionRootUrl: string): string {
  try {
    const url = new URL(extensionRootUrl);
    if (url.protocol !== 'moz-extension:' || !url.hostname) {
      throw new TypeError('Invalid Firefox extension origin');
    }
    return url.hostname;
  } catch (error) {
    throw new ExtensionContractError({
      capability: 'request-header-override',
      operation: 'initialize',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'extension-origin',
      },
      cause: error,
    });
  }
}

export function firefoxReferrerPolicyObserver(
  rawEvent: FirefoxHeadersReceivedEvent | undefined,
): DocumentReferrerPolicyObserver {
  const event = requireNamespace(
    rawEvent,
    'document-referrer-policy',
    'webRequest.onHeadersReceived',
  );
  requireFunction(event.addListener, 'document-referrer-policy', 'onObserved');
  requireFunction(
    event.removeListener,
    'document-referrer-policy',
    'cancel:onObserved',
  );

  return {
    onObserved(listener) {
      const rawListener = (details: FirefoxHeadersReceivedDetails): void => {
        if (
          !details.documentId
          || typeof details.tabId !== 'number'
          || details.tabId < 0
          || typeof details.frameId !== 'number'
          || details.frameId < 0
          || !details.url
        ) {
          return;
        }
        const policy = details.responseHeaders
          ?.filter(
            (candidate) => candidate.name.toLowerCase() === 'referrer-policy',
          )
          .flatMap((candidate) => candidate.value ? [candidate.value] : [])
          .join(', ');
        listener({
          document: {
            documentId: details.documentId,
            tabId: details.tabId,
            frameId: details.frameId,
            url: details.url,
          },
          ...(policy ? { policy } : {}),
        });
      };
      try {
        event.addListener(
          rawListener,
          {
            urls: ['<all_urls>'],
            types: ['main_frame', 'sub_frame'],
          },
          ['responseHeaders'],
        );
      } catch (error) {
        throw operationFailure(
          'document-referrer-policy',
          'onObserved',
          error,
        );
      }
      return idempotentCancel(() => {
        try {
          event.removeListener(rawListener);
        } catch (error) {
          throw operationFailure(
            'document-referrer-policy',
            'cancel:onObserved',
            error,
          );
        }
      });
    },
  };
}

export function firefoxRequestHeaderOverride(
  rawDnr: FirefoxDeclarativeNetRequest | undefined,
  extensionRootUrl: string,
): RequestHeaderOverride {
  const dnr = requireNamespace(
    rawDnr,
    'request-header-override',
    'declarativeNetRequest',
  );
  requireFunction(
    dnr.getDynamicRules,
    'request-header-override',
    'initialize',
  );
  requireFunction(
    dnr.getSessionRules,
    'request-header-override',
    'initialize',
  );
  requireFunction(
    dnr.updateDynamicRules,
    'request-header-override',
    'acquire',
  );
  requireFunction(
    dnr.updateSessionRules,
    'request-header-override',
    'acquire',
  );
  const initiatorDomain = extensionInitiatorDomain(extensionRootUrl);
  return coordinatedRequestHeaderOverride({
    firstRuleId: firstHeaderOverrideRuleId,
    lastRuleId: lastHeaderOverrideRuleId,
    initialize: async () => {
      const [sessionRules, dynamicRules] = await Promise.all([
        dnr.getSessionRules(),
        dnr.getDynamicRules(),
      ]);
      const staleSessionRuleIds = sessionRules
        .filter((rule) => (
          rule.id === legacySessionHeaderOverrideRuleId
          || isAppOwnedRule(rule)
        ))
        .map((rule) => rule.id);
      const staleDynamicRuleIds = dynamicRules
        .filter((rule) => rule.id === legacyDynamicHeaderOverrideRuleId)
        .map((rule) => rule.id);
      if (staleSessionRuleIds.length > 0) {
        await dnr.updateSessionRules({
          removeRuleIds: staleSessionRuleIds,
          addRules: [],
        });
      }
      if (staleDynamicRuleIds.length > 0) {
        await dnr.updateDynamicRules({
          removeRuleIds: staleDynamicRuleIds,
          addRules: [],
        });
      }
    },
    async install(ruleId, targetUrl, request) {
      await dnr.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: request.headers.map((header) => ({
              header: header.name,
              operation: 'set',
              value: header.value,
            })),
          },
          condition: {
            initiatorDomains: [initiatorDomain],
            requestDomains: [targetUrl.hostname],
            requestMethods: ['get'],
            resourceTypes: ['xmlhttprequest'],
            tabIds: [-1],
            regexFilter: exactUrlRegex(targetUrl.toString()),
          },
        }],
      });
    },
    async remove(ruleIds) {
      await dnr.updateSessionRules({
        removeRuleIds: [...ruleIds],
        addRules: [],
      });
    },
  });
}
