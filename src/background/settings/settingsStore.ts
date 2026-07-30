import {
  extensionSettingsStorageKey,
  normalizeSettings,
} from "../../shared/config";
import type { ExtensionSettings } from "../../shared/config";
import type {
  ExtensionStorage,
} from "../../../apps/extension/src/capabilities/contracts";
import { normalizeJsonValue } from "../../shared/jsonValue";

export type SettingsStore = {
  get(): Promise<ExtensionSettings>;
  set(settings: ExtensionSettings): Promise<ExtensionSettings>;
};

export function createSettingsStore(storage: ExtensionStorage): SettingsStore {
  return {
    async get() {
      const saved = await storage.read([extensionSettingsStorageKey]);
      return normalizeSettings(saved[extensionSettingsStorageKey]);
    },
    async set(settings) {
      const normalized = normalizeSettings(settings);
      await storage.write({
        [extensionSettingsStorageKey]: normalizeJsonValue(normalized),
      });
      return normalized;
    },
  };
}
