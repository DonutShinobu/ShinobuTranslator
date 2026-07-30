import type { ExtensionStorage, JsonValue } from './contracts';
import type { ExtensionCapability } from './errors';
import {
  assertJsonValue,
  chromeCallback,
  isObject,
  requireFunction,
  requireNamespace,
  type ChromeRuntime,
  type ChromeStorageArea,
} from './chromeInternal';
import { ExtensionOperationError } from './errors';

export function extensionStorage(
  runtime: ChromeRuntime,
  rawArea: ChromeStorageArea | undefined,
  area: 'persistent' | 'session',
): ExtensionStorage {
  const capability: ExtensionCapability = area === 'persistent'
    ? 'persistent-storage'
    : 'session-storage';
  const storage = requireNamespace(rawArea, capability, `storage.${area}`);
  requireFunction(storage.get, capability, 'read');
  requireFunction(storage.set, capability, 'write');
  requireFunction(storage.remove, capability, 'remove');
  return {
    async read(keys) {
      const values = await chromeCallback<Record<string, unknown>>(
        runtime,
        capability,
        'read',
        (complete) => storage.get([...keys], complete),
      );
      if (!isObject(values)) {
        throw new ExtensionOperationError({
          capability,
          operation: 'read',
          code: 'serialization-failed',
          retryable: false,
          diagnostic: {
            valueType: typeof values,
          },
        });
      }
      const result: Record<string, JsonValue | undefined> = {};
      for (const key of keys) {
        if (!Object.hasOwn(values, key)) {
          result[key] = undefined;
          continue;
        }
        const value = values[key];
        assertJsonValue(value, capability, 'read');
        result[key] = value;
      }
      return result;
    },
    async write(values) {
      const rawValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        assertJsonValue(value, capability, 'write');
        rawValues[key] = value;
      }
      await chromeCallback<void>(
        runtime,
        capability,
        'write',
        (complete) => storage.set(rawValues, () => complete(undefined)),
      );
    },
    async remove(keys) {
      await chromeCallback<void>(
        runtime,
        capability,
        'remove',
        (complete) => storage.remove([...keys], () => complete(undefined)),
      );
    },
  };
}
