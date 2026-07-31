import type { ExtensionStorage, JsonValue } from './contracts';
import type { ExtensionCapability } from './errors';
import {
  ExtensionOperationError,
} from './errors';
import {
  assertJsonValue,
  isObject,
  requireFunction,
  requireNamespace,
} from './adapterInternal';
import {
  firefoxPromise,
  type FirefoxStorageArea,
} from './firefoxInternal';

export function firefoxExtensionStorage(
  rawArea: FirefoxStorageArea | undefined,
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
      const values = await firefoxPromise(
        capability,
        'read',
        () => storage.get([...keys]),
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
      await firefoxPromise(
        capability,
        'write',
        () => storage.set(rawValues),
      );
    },
    async remove(keys) {
      await firefoxPromise(
        capability,
        'remove',
        () => storage.remove([...keys]),
      );
    },
  };
}
