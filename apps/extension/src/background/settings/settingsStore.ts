import {
  extensionSettingsStorageKey,
  normalizeSettings,
} from "../../shared/config";
import type { ExtensionSettings } from "../../shared/config";
import { storageGet, storageSet } from "../storage/chromeStorage";

export async function getSettings(): Promise<ExtensionSettings> {
  const saved = await storageGet(extensionSettingsStorageKey);
  return normalizeSettings(saved);
}

export async function setSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await storageSet(extensionSettingsStorageKey, normalized);
  return normalized;
}
