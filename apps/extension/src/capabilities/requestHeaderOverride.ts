import type {
  RequestHeaderOverride,
  RequestHeaderOverrideRequest,
} from './contracts';
import {
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
} from './errors';
import { operationFailure } from './adapterInternal';

type RequestHeaderOverrideBackend = Readonly<{
  firstRuleId: number;
  lastRuleId?: number;
  initialize(): Promise<void>;
  install(
    ruleId: number,
    targetUrl: URL,
    request: RequestHeaderOverrideRequest,
  ): Promise<void>;
  remove(ruleIds: readonly number[]): Promise<void>;
}>;

function cleanupFailure(
  operation: 'acquire' | 'release',
  error: unknown,
): ExtensionOperationError {
  return error instanceof ExtensionOperationError
    && error.code === 'cleanup-failed'
    ? error
    : new ExtensionOperationError({
        capability: 'request-header-override',
        operation,
        code: 'cleanup-failed',
        retryable: true,
        diagnostic: sanitizedErrorDiagnostic(error),
        cause: error,
      });
}

function validateRequest(request: RequestHeaderOverrideRequest): URL {
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
  return targetUrl;
}

export function coordinatedRequestHeaderOverride(
  backend: RequestHeaderOverrideBackend,
): RequestHeaderOverride {
  let nextRuleId = backend.firstRuleId;
  let operationQueue = Promise.resolve();
  let leaseQueue = Promise.resolve();
  const pendingCleanupRuleIds = new Set<number>();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const runInitialization = () => {
    let result: Promise<void>;
    try {
      result = backend.initialize();
    } catch (error) {
      result = Promise.reject(error);
    }
    operationQueue = result.then(() => undefined, () => undefined);
    return result.then(
      () => undefined,
      (error: unknown) => cleanupFailure('acquire', error),
    );
  };
  let initialization = runInitialization();
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
      const targetUrl = validateRequest(request);
      if (
        backend.lastRuleId !== undefined
        && nextRuleId > backend.lastRuleId
      ) {
        nextRuleId = backend.firstRuleId;
      }
      const ruleId = nextRuleId;
      nextRuleId += 1;
      const reservation = reserveLease();

      try {
        await reservation.wait;
        let initializationError = await initialization;
        if (initializationError) {
          initialization = runInitialization();
          initializationError = await initialization;
        }
        if (initializationError) throw initializationError;

        if (pendingCleanupRuleIds.size > 0) {
          const ruleIds = [...pendingCleanupRuleIds];
          try {
            await enqueue(() => backend.remove(ruleIds));
            for (const pendingRuleId of ruleIds) {
              pendingCleanupRuleIds.delete(pendingRuleId);
            }
          } catch (error) {
            throw cleanupFailure('acquire', error);
          }
        }

        await enqueue(() => backend.install(ruleId, targetUrl, request));
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
              await backend.remove([ruleId]);
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
