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
          !details.documentId
          || typeof details.tabId !== 'number'
          || typeof details.frameId !== 'number'
          || !details.url
        ) {
          return;
        }
        const header = details.responseHeaders?.find(
          (candidate) => candidate.name.toLowerCase() === 'referrer-policy',
        );
        listener({
          document: {
            documentId: details.documentId,
            tabId: details.tabId,
            frameId: details.frameId,
            url: details.url,
          },
          ...(header?.value ? { policy: header.value } : {}),
        });
      };
      event.addListener(
        rawListener,
        {
          urls: ['<all_urls>'],
          types: ['main_frame', 'sub_frame'],
        },
        ['responseHeaders', 'extraHeaders'],
      );
      return idempotentCancel(() => event.removeListener(rawListener));
    },
  };
}

export function requestHeaderOverride(
  rawDnr: ChromeDeclarativeNetRequest | undefined,
): RequestHeaderOverride {
  const dnr = requireNamespace(
    rawDnr,
    'request-header-override',
    'declarativeNetRequest',
  );
  requireFunction(dnr.updateDynamicRules, 'request-header-override', 'acquire');
  let nextRuleId = 1_000_000;
  let updateQueue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = updateQueue.then(operation, operation);
    updateQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    async acquire(request) {
      try {
        new URL(request.url);
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
      try {
        await enqueue(() => dnr.updateDynamicRules({
          removeRuleIds: [],
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
              urlFilter: request.url,
            },
          }],
        }));
      } catch (error) {
        throw operationFailure('request-header-override', 'acquire', error);
      }

      let releasePromise: Promise<void> | undefined;
      return {
        release() {
          if (releasePromise) return releasePromise;
          const attempt = enqueue(async () => {
            try {
              await dnr.updateDynamicRules({
                removeRuleIds: [ruleId],
                addRules: [],
              });
            } catch (error) {
              throw new ExtensionOperationError({
                capability: 'request-header-override',
                operation: 'release',
                code: 'cleanup-failed',
                retryable: true,
                diagnostic: sanitizedErrorDiagnostic(error),
                cause: error,
              });
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
