import type { CancelSubscription, JsonValue } from './contracts';
import {
  ExtensionContractError,
  ExtensionOperationError,
  sanitizedErrorDiagnostic,
  type ExtensionCapability,
  type ExtensionOperation,
} from './errors';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requireFunction(
  value: unknown,
  capability: ExtensionCapability,
  operation: ExtensionOperation,
): asserts value is (...args: never[]) => unknown {
  if (typeof value === 'function') return;
  throw new ExtensionContractError({
    capability,
    operation,
    code: 'context-unavailable',
    retryable: false,
    diagnostic: {
      missing: operation,
    },
  });
}

export function isJsonValue(
  value: unknown,
  seen = new Set<object>(),
): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (!isObject(value)) return false;
  if (seen.has(value)) return false;

  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return false;
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
        return false;
      }
    }

    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((entry) => isJsonValue(entry, seen))
      : Object.values(value).every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  } catch {
    seen.delete(value);
    return false;
  }
}

export function assertJsonValue(
  value: unknown,
  capability: ExtensionCapability,
  operation: ExtensionOperation,
): asserts value is JsonValue {
  if (isJsonValue(value)) return;
  throw new ExtensionOperationError({
    capability,
    operation,
    code: 'serialization-failed',
    retryable: false,
    diagnostic: {
      valueType: value === null ? 'null' : typeof value,
    },
  });
}

export function idempotentCancel(cancel: () => void): CancelSubscription {
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    cancel();
  };
}

export function operationFailure(
  capability: ExtensionCapability,
  operation: ExtensionOperation,
  error: unknown,
): ExtensionOperationError {
  return error instanceof ExtensionOperationError
    ? error
    : new ExtensionOperationError({
      capability,
      operation,
      code: 'browser-rejected',
      retryable: false,
      diagnostic: sanitizedErrorDiagnostic(error),
      cause: error,
    });
}

export function requireNamespace<T>(
  value: T | undefined,
  capability: ExtensionCapability,
  namespace: string,
): T {
  if (value !== undefined && value !== null) return value;
  throw new ExtensionContractError({
    capability,
    operation: 'initialize',
    code: 'context-unavailable',
    retryable: false,
    diagnostic: {
      missing: namespace,
    },
  });
}
