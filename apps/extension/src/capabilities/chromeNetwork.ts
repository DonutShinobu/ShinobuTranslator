import type {
  DocumentReferrerPolicyObserver,
  RequestHeaderOverride,
} from './contracts';
import {
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
} from './errors';
import {
  idempotentCancel,
  operationFailure,
  requireFunction,
  requireNamespace,
  type ChromeDeclarativeNetRequest,
  type ChromeHeadersReceivedDetails,
  type ChromeHeadersReceivedEvent,
} from './chromeInternal';

const legacyDynamicHeaderOverrideRuleId = 1;
const legacySessionHeaderOverrideRuleId = 2;
const firstHeaderOverrideRuleId = 1_000_000;

function documentIdentityId(details: {
  documentId?: string;
  tabId: number;
  frameId: number;
}): string {
  return details.documentId
    || `synthetic-frame:${details.tabId}:${details.frameId}`;
}

export function referrerPolicyObserver(
  rawEvent: ChromeHeadersReceivedEvent | undefined,
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
      const rawListener = (details: ChromeHeadersReceivedDetails): void => {
        if (
          typeof details.tabId !== 'number'
          || typeof details.frameId !== 'number'
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
            documentId: documentIdentityId({
              documentId: details.documentId,
              tabId: details.tabId,
              frameId: details.frameId,
            }),
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
          ['responseHeaders', 'extraHeaders'],
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

export function requestHeaderOverride(
  rawDnr: ChromeDeclarativeNetRequest | undefined,
  extensionId: string | undefined,
): RequestHeaderOverride {
  const dnr = requireNamespace(
    rawDnr,
    'request-header-override',
    'declarativeNetRequest',
  );
  requireFunction(dnr.updateDynamicRules, 'request-header-override', 'acquire');
  requireFunction(dnr.updateSessionRules, 'request-header-override', 'acquire');
  const initiatorDomain = requireNamespace(
    extensionId || undefined,
    'request-header-override',
    'runtime.id',
  );
  let nextRuleId = firstHeaderOverrideRuleId;
  let updateQueue = Promise.resolve();
  let leaseQueue = Promise.resolve();
  const pendingCleanupRuleIds = new Set<number>();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = updateQueue.then(operation, operation);
    updateQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const cleanupFailure = (
    operation: 'acquire' | 'release',
    error: unknown,
  ): ExtensionOperationError => new ExtensionOperationError({
    capability: 'request-header-override',
    operation,
    code: 'cleanup-failed',
    retryable: true,
    diagnostic: sanitizedErrorDiagnostic(error),
    cause: error,
  });
  const cleanupLegacyRules = () => Promise.all([
    dnr.updateDynamicRules({
      removeRuleIds: [legacyDynamicHeaderOverrideRuleId],
      addRules: [],
    }),
    dnr.updateSessionRules({
      removeRuleIds: [legacySessionHeaderOverrideRuleId],
      addRules: [],
    }),
  ]).then(
    () => undefined,
    (error: unknown) => cleanupFailure('acquire', error),
  );
  let legacyCleanup = cleanupLegacyRules();
  const reserveLease = (): {
    wait: Promise<void>;
    finish(): void;
  } => {
    const wait = leaseQueue;
    let finishCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      finishCurrent = resolve;
    });
    leaseQueue = wait.then(() => current);
    let finished = false;
    return {
      wait,
      finish() {
        if (finished) return;
        finished = true;
        finishCurrent();
      },
    };
  };
  return {
    async acquire(request) {
      let targetUrl: URL;
      try {
        targetUrl = new URL(request.url);
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
          throw new TypeError('Unsupported request URL protocol');
        }
      } catch (error) {
        throw new ExtensionOperationError({
          capability: 'request-header-override',
          operation: 'acquire',
          code: 'serialization-failed',
          retryable: false,
          diagnostic: sanitizedErrorDiagnostic(error),
          cause: error,
        });
      }
      for (const header of request.headers) {
        if (!header.name || typeof header.value !== 'string') {
          throw new ExtensionOperationError({
            capability: 'request-header-override',
            operation: 'acquire',
            code: 'serialization-failed',
            retryable: false,
            diagnostic: {
              invalidField: 'headers',
            },
          });
        }
      }
      const ruleId = nextRuleId;
      nextRuleId += 1;
      const reservation = reserveLease();
      try {
        await reservation.wait;
        let legacyCleanupError = await legacyCleanup;
        if (legacyCleanupError) {
          legacyCleanup = cleanupLegacyRules();
          legacyCleanupError = await legacyCleanup;
        }
        if (legacyCleanupError) throw legacyCleanupError;
        if (pendingCleanupRuleIds.size > 0) {
          const ruleIds = [...pendingCleanupRuleIds];
          try {
            await enqueue(() => dnr.updateSessionRules({
              removeRuleIds: ruleIds,
              addRules: [],
            }));
            for (const pendingRuleId of ruleIds) {
              pendingCleanupRuleIds.delete(pendingRuleId);
            }
          } catch (error) {
            throw cleanupFailure('acquire', error);
          }
        }
        await enqueue(() => dnr.updateSessionRules({
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
              urlFilter: request.url,
            },
          }],
        }));
      } catch (error) {
        reservation.finish();
        throw operationFailure('request-header-override', 'acquire', error);
      }

      let releasePromise: Promise<void> | undefined;
      let released = false;
      return {
        release() {
          if (released) return Promise.resolve();
          if (releasePromise) return releasePromise;
          const attempt = enqueue(async () => {
            try {
              await dnr.updateSessionRules({
                removeRuleIds: [ruleId],
                addRules: [],
              });
              pendingCleanupRuleIds.delete(ruleId);
              released = true;
            } catch (error) {
              pendingCleanupRuleIds.add(ruleId);
              throw cleanupFailure('release', error);
            } finally {
              reservation.finish();
            }
          });
          releasePromise = attempt.catch((error: unknown) => {
            releasePromise = undefined;
            throw error;
          });
          return releasePromise;
        },
      };
    },
  };
}
