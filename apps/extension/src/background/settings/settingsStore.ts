import {
  defaultExtensionSettings,
  extensionControlStateStorageKey,
  extensionInterfacePreferencesStorageKey,
  extensionProviderCredentialsStorageKey,
  extensionSettingsRevisionStorageKey,
  extensionSettingsStorageKey,
  extensionTranslationDefaultsStorageKey,
  normalizeSettings,
} from '../../shared/config';
import type { ExtensionSettings, LlmProvider } from '../../shared/config';
import {
  mergeExtensionSettingsProjection,
  toExtensionSettingsProjection,
  type ExtensionSettingsProjection,
} from '../../shared/extensionControl';
import {
  storageGet,
  storageRemove,
  storageSet,
} from '../storage/chromeStorage';

type ExtensionInterfacePreferences = Pick<
  ExtensionSettings,
  | 'showElapsedTime'
  | 'showStageTimingDetails'
  | 'stageTimingCardExpanded'
  | 'debugOptionsExpanded'
>;

type ExtensionTranslationDefaults = Omit<
  ExtensionSettingsProjection,
  keyof ExtensionInterfacePreferences
>;

type ExtensionProviderCredentials = Partial<Record<LlmProvider, string>>;

type ExtensionControlHead = {
  schemaVersion: 1;
  revision: number;
  generation: string;
};

type VersionedSection<T> = {
  schemaVersion: 1;
  value: T;
};

type LegacyAtomicControlRecord = {
  schemaVersion: 1;
  revision: number;
  translationDefaults: ExtensionTranslationDefaults;
  interfacePreferences: ExtensionInterfacePreferences;
  providerCredentials: ExtensionProviderCredentials;
};

type SplitSettings = {
  translationDefaults: ExtensionTranslationDefaults;
  interfacePreferences: ExtensionInterfacePreferences;
  providerCredentials: ExtensionProviderCredentials;
};

export type StoredExtensionSettingsState = {
  settings: ExtensionSettings;
  revision: number;
};

const legacySplitStorageKeys = [
  extensionTranslationDefaultsStorageKey,
  extensionInterfacePreferencesStorageKey,
  extensionProviderCredentialsStorageKey,
  extensionSettingsRevisionStorageKey,
];

let stateInitialization: Promise<void> | null = null;
let volatileState: StoredExtensionSettingsState | null = null;
let generationSequence = 0;

function splitSettings(settings: ExtensionSettings): SplitSettings {
  const projection = toExtensionSettingsProjection(settings);
  const {
    showElapsedTime,
    showStageTimingDetails,
    stageTimingCardExpanded,
    debugOptionsExpanded,
    ...translationDefaults
  } = projection;
  const providerCredentials = Object.fromEntries(
    Object.entries(settings.llmProfiles)
      .filter(([, profile]) => profile.apiKey.trim().length > 0)
      .map(([provider, profile]) => [provider, profile.apiKey.trim()]),
  ) as ExtensionProviderCredentials;
  return {
    translationDefaults,
    interfacePreferences: {
      showElapsedTime,
      showStageTimingDetails,
      stageTimingCardExpanded,
      debugOptionsExpanded,
    },
    providerCredentials,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function isControlHead(value: unknown): value is ExtensionControlHead {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.generation === 'string'
    && value.generation.length > 0;
}

function isVersionedSection(value: unknown): value is VersionedSection<unknown> {
  return isRecord(value) && value.schemaVersion === 1 && 'value' in value;
}

function composeSettings(
  translationDefaults: unknown,
  interfacePreferences: unknown,
  providerCredentials: unknown,
): ExtensionSettings {
  const defaults = isRecord(translationDefaults)
    ? translationDefaults
    : toExtensionSettingsProjection(defaultExtensionSettings);
  const preferences = isRecord(interfacePreferences)
    ? interfacePreferences
    : {};
  const credentials = isRecord(providerCredentials)
    ? providerCredentials
    : {};
  const projectedProfiles = isRecord(defaults.llmProfiles)
    ? defaults.llmProfiles
    : toExtensionSettingsProjection(defaultExtensionSettings).llmProfiles;
  const settingsProjection = {
    ...toExtensionSettingsProjection(defaultExtensionSettings),
    ...defaults,
    ...preferences,
    llmProfiles: projectedProfiles,
  } as ExtensionSettingsProjection;
  const currentWithCredentials = {
    ...defaultExtensionSettings,
    llmProfiles: Object.fromEntries(
      Object.entries(defaultExtensionSettings.llmProfiles).map(([provider, profile]) => [
        provider,
        {
          ...profile,
          apiKey: typeof credentials[provider] === 'string'
            ? credentials[provider]
            : '',
        },
      ]),
    ) as ExtensionSettings['llmProfiles'],
  };
  return normalizeSettings(
    mergeExtensionSettingsProjection(settingsProjection, currentWithCredentials),
  );
}

function sectionStorageKey(baseKey: string, generation: string): string {
  return `${baseKey}.${generation}`;
}

function sectionStorageKeys(generation: string): [string, string, string] {
  return [
    sectionStorageKey(extensionTranslationDefaultsStorageKey, generation),
    sectionStorageKey(extensionInterfacePreferencesStorageKey, generation),
    sectionStorageKey(extensionProviderCredentialsStorageKey, generation),
  ];
}

function nextGeneration(revision: number): string {
  generationSequence += 1;
  return `${revision}-${Date.now().toString(36)}-${generationSequence.toString(36)}`;
}

async function readCommittedState(
  initialHead?: ExtensionControlHead,
): Promise<StoredExtensionSettingsState | null> {
  let head = initialHead;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    head ??= await storageGet(extensionControlStateStorageKey) as ExtensionControlHead;
    if (!isControlHead(head)) return null;
    const [translationKey, preferencesKey, credentialsKey] = sectionStorageKeys(head.generation);
    const [translation, preferences, credentials, latestHead] = await Promise.all([
      storageGet(translationKey),
      storageGet(preferencesKey),
      storageGet(credentialsKey),
      storageGet(extensionControlStateStorageKey),
    ]);
    if (!isControlHead(latestHead)) return null;
    if (latestHead.generation !== head.generation) {
      head = latestHead;
      continue;
    }
    if (
      !isVersionedSection(translation)
      || !isVersionedSection(preferences)
      || !isVersionedSection(credentials)
    ) {
      return null;
    }
    return {
      settings: composeSettings(
        translation.value,
        preferences.value,
        credentials.value,
      ),
      revision: normalizeRevision(head.revision),
    };
  }
  return null;
}

async function persistState(state: StoredExtensionSettingsState): Promise<void> {
  const normalized: StoredExtensionSettingsState = {
    settings: normalizeSettings(state.settings),
    revision: normalizeRevision(state.revision),
  };
  const split = splitSettings(normalized.settings);
  const previousHead = await storageGet(extensionControlStateStorageKey);
  const head: ExtensionControlHead = {
    schemaVersion: 1,
    revision: normalized.revision,
    generation: nextGeneration(normalized.revision),
  };
  const [translationKey, preferencesKey, credentialsKey] = sectionStorageKeys(head.generation);
  await Promise.all([
    storageSet(translationKey, {
      schemaVersion: 1,
      value: split.translationDefaults,
    } satisfies VersionedSection<ExtensionTranslationDefaults>),
    storageSet(preferencesKey, {
      schemaVersion: 1,
      value: split.interfacePreferences,
    } satisfies VersionedSection<ExtensionInterfacePreferences>),
    storageSet(credentialsKey, {
      schemaVersion: 1,
      value: split.providerCredentials,
    } satisfies VersionedSection<ExtensionProviderCredentials>),
  ]);
  await storageSet(extensionControlStateStorageKey, head);
  volatileState = normalized;

  if (isControlHead(previousHead) && previousHead.generation !== head.generation) {
    try {
      await storageRemove(sectionStorageKeys(previousHead.generation));
    } catch {
      // The commit is already visible. Old generations are harmless orphan records.
    }
  }
}

async function removeLegacyRecords(): Promise<void> {
  try {
    await storageRemove([extensionSettingsStorageKey, ...legacySplitStorageKeys]);
  } catch {
    // The commit head already selects the canonical generation.
  }
}

async function initializeStateRecord(): Promise<void> {
  const saved = await storageGet(extensionControlStateStorageKey);
  if (isControlHead(saved)) {
    const committed = await readCommittedState(saved);
    if (!committed) throw new Error('扩展控制状态提交不完整');
    volatileState = committed;
    return;
  }

  let state: StoredExtensionSettingsState;
  if (
    isRecord(saved)
    && saved.schemaVersion === 1
    && 'translationDefaults' in saved
  ) {
    const legacyAtomic = saved as LegacyAtomicControlRecord;
    state = {
      settings: composeSettings(
        legacyAtomic.translationDefaults,
        legacyAtomic.interfacePreferences,
        legacyAtomic.providerCredentials,
      ),
      revision: normalizeRevision(legacyAtomic.revision),
    };
  } else {
    const [translationDefaults, interfacePreferences, providerCredentials, splitRevision] = await Promise.all([
      storageGet(extensionTranslationDefaultsStorageKey),
      storageGet(extensionInterfacePreferencesStorageKey),
      storageGet(extensionProviderCredentialsStorageKey),
      storageGet(extensionSettingsRevisionStorageKey),
    ]);
    state = isRecord(translationDefaults)
      ? {
          settings: composeSettings(
            translationDefaults,
            interfacePreferences,
            providerCredentials,
          ),
          revision: normalizeRevision(splitRevision),
        }
      : {
          settings: normalizeSettings(await storageGet(extensionSettingsStorageKey)),
          revision: normalizeRevision(splitRevision),
        };
  }
  await persistState(state);
  await removeLegacyRecords();
}

async function ensureStateRecord(): Promise<void> {
  const initialization = stateInitialization ?? initializeStateRecord();
  stateInitialization = initialization;
  try {
    await initialization;
  } catch (error) {
    if (stateInitialization === initialization) stateInitialization = null;
    throw error;
  }
}

export async function getSettingsState(): Promise<StoredExtensionSettingsState> {
  await ensureStateRecord();
  const committed = await readCommittedState();
  if (committed) {
    volatileState = committed;
    return committed;
  }
  if (volatileState) return volatileState;
  stateInitialization = null;
  await ensureStateRecord();
  const recovered = await readCommittedState();
  if (recovered) return recovered;
  if (volatileState) return volatileState;
  throw new Error('扩展控制状态记录不可用');
}

export async function setSettingsState(
  state: StoredExtensionSettingsState,
): Promise<StoredExtensionSettingsState> {
  await ensureStateRecord();
  const normalized = {
    settings: normalizeSettings(state.settings),
    revision: normalizeRevision(state.revision),
  };
  await persistState(normalized);
  await removeLegacyRecords();
  return normalized;
}

export async function getSettings(): Promise<ExtensionSettings> {
  return (await getSettingsState()).settings;
}

export async function setSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const current = await getSettingsState();
  return (await setSettingsState({ settings, revision: current.revision })).settings;
}
