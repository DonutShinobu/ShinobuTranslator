export const WEB_SETTINGS_SCHEMA_VERSION = 2 as const;
export const WEB_SETTINGS_STORAGE_KEY = 'shinobu:web-settings';
export const LOCKED_PROCESSING_CONFIG_SCHEMA_VERSION = 1 as const;

export type UiLocale = 'zh-CN' | 'zh-TW';
export type TargetLanguage = 'zh-CHS' | 'zh-CHT';
export type ProcessMode = 'translate' | 'original' | 'erase';
export type TranslationProviderId =
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'minimax'
  | 'mimo'
  | 'openai'
  | 'custom';

export type WebProviderProfile = {
  baseUrl: string;
  model: string;
};

export type WebProviderProfiles = Record<TranslationProviderId, WebProviderProfile>;

export type WebSettings = {
  schemaVersion: typeof WEB_SETTINGS_SCHEMA_VERSION;
  uiLocale: UiLocale;
  targetLanguage: TargetLanguage;
  processMode: ProcessMode;
  translationProviderId: TranslationProviderId;
  providerProfiles: WebProviderProfiles;
};

export type LockedProcessingConfig = {
  schemaVersion: typeof LOCKED_PROCESSING_CONFIG_SCHEMA_VERSION;
  targetLanguage: TargetLanguage;
  processMode: ProcessMode;
  provider: {
    id: string;
    target: string;
    model: string;
  };
};

export type DecodedWebSettings = {
  settings: WebSettings;
  needsWrite: boolean;
};

export const translationProviderOptions: ReadonlyArray<{
  id: TranslationProviderId;
  label: string;
}> = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'glm', label: 'GLM / Z.AI' },
  { id: 'kimi', label: 'Kimi / Moonshot' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'mimo', label: 'MiMo' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'custom', label: 'OpenAI Compatible' },
];

export const defaultWebProviderProfiles: WebProviderProfiles = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  glm: {
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1',
    model: 'MiniMax-M3',
  },
  mimo: {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-luna',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
};

const uiLocales: ReadonlySet<string> = new Set<UiLocale>(['zh-CN', 'zh-TW']);
const targetLanguages: ReadonlySet<string> = new Set<TargetLanguage>(['zh-CHS', 'zh-CHT']);
const processModes: ReadonlySet<string> = new Set<ProcessMode>(['translate', 'original', 'erase']);
const translationProviderIds: ReadonlySet<string> = new Set(
  translationProviderOptions.map((provider) => provider.id),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultTargetLanguage(uiLocale: UiLocale): TargetLanguage {
  return uiLocale === 'zh-TW' ? 'zh-CHT' : 'zh-CHS';
}

export function inferUiLocale(browserLanguage: string | undefined): UiLocale {
  const normalized = browserLanguage?.trim().toLowerCase() ?? '';
  if (
    normalized.startsWith('zh-tw')
    || normalized.startsWith('zh-hk')
    || normalized.startsWith('zh-mo')
    || normalized.includes('hant')
  ) {
    return 'zh-TW';
  }
  return 'zh-CN';
}

export function createDefaultWebSettings(uiLocale: UiLocale): WebSettings {
  return {
    schemaVersion: WEB_SETTINGS_SCHEMA_VERSION,
    uiLocale,
    targetLanguage: defaultTargetLanguage(uiLocale),
    processMode: 'translate',
    translationProviderId: 'deepseek',
    providerProfiles: structuredClone(defaultWebProviderProfiles),
  };
}

export function lockProcessingConfig(settings: WebSettings): LockedProcessingConfig {
  const profile = settings.providerProfiles[settings.translationProviderId];
  return {
    schemaVersion: LOCKED_PROCESSING_CONFIG_SCHEMA_VERSION,
    targetLanguage: settings.targetLanguage,
    processMode: settings.processMode,
    provider: {
      id: settings.translationProviderId,
      target: normalizeProviderBaseUrl(profile.baseUrl),
      model: profile.model.trim(),
    },
  };
}

export function isKnownTranslationProviderId(value: string): value is TranslationProviderId {
  return translationProviderIds.has(value);
}

export function decodeLockedProcessingConfig(value: unknown): LockedProcessingConfig | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== LOCKED_PROCESSING_CONFIG_SCHEMA_VERSION
    || typeof value.targetLanguage !== 'string'
    || !targetLanguages.has(value.targetLanguage)
    || typeof value.processMode !== 'string'
    || !processModes.has(value.processMode)
    || !isRecord(value.provider)
    || typeof value.provider.id !== 'string'
    || !value.provider.id.trim()
    || typeof value.provider.target !== 'string'
    || typeof value.provider.model !== 'string'
  ) {
    return null;
  }
  return {
    schemaVersion: LOCKED_PROCESSING_CONFIG_SCHEMA_VERSION,
    targetLanguage: value.targetLanguage as TargetLanguage,
    processMode: value.processMode as ProcessMode,
    provider: {
      id: value.provider.id.trim(),
      target: normalizeProviderBaseUrl(value.provider.target),
      model: value.provider.model.trim(),
    },
  };
}

export function restoreWebSettingsFromLockedConfig(
  lockedConfig: LockedProcessingConfig,
  current: WebSettings,
): WebSettings | null {
  if (!isKnownTranslationProviderId(lockedConfig.provider.id)) return null;
  return {
    ...structuredClone(current),
    targetLanguage: lockedConfig.targetLanguage,
    processMode: lockedConfig.processMode,
    translationProviderId: lockedConfig.provider.id,
    providerProfiles: {
      ...structuredClone(current.providerProfiles),
      [lockedConfig.provider.id]: {
        baseUrl: lockedConfig.provider.target,
        model: lockedConfig.provider.model,
      },
    },
  };
}

export function createWebSettingsDraftFromLockedConfig(
  lockedConfig: LockedProcessingConfig,
  current: WebSettings,
): {
  settings: WebSettings;
  providerSelectionRequired: boolean;
} {
  const restored = restoreWebSettingsFromLockedConfig(lockedConfig, current);
  if (restored) {
    return {
      settings: restored,
      providerSelectionRequired: false,
    };
  }
  return {
    settings: {
      ...structuredClone(current),
      targetLanguage: lockedConfig.targetLanguage,
      processMode: lockedConfig.processMode,
    },
    providerSelectionRequired: true,
  };
}

function normalizeProviderProfiles(value: unknown): WebProviderProfiles {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(
    translationProviderOptions.map(({ id }) => {
      const fallback = defaultWebProviderProfiles[id];
      const candidate = isRecord(record[id]) ? record[id] : {};
      return [
        id,
        {
          baseUrl: typeof candidate.baseUrl === 'string'
            ? candidate.baseUrl.trim()
            : fallback.baseUrl,
          model: typeof candidate.model === 'string'
            ? candidate.model.trim()
            : fallback.model,
        },
      ];
    }),
  ) as WebProviderProfiles;
}

function normalizeWebSettings(
  value: Record<string, unknown>,
  fallbackLocale: UiLocale,
): WebSettings {
  const rawLocale = value.uiLocale;
  const uiLocale = typeof rawLocale === 'string' && uiLocales.has(rawLocale)
    ? rawLocale as UiLocale
    : fallbackLocale;

  const rawTargetLanguage = value.targetLanguage ?? value.targetLang;
  const targetLanguage =
    typeof rawTargetLanguage === 'string' && targetLanguages.has(rawTargetLanguage)
      ? rawTargetLanguage as TargetLanguage
      : defaultTargetLanguage(uiLocale);

  const rawProcessMode = value.processMode;
  const processMode = typeof rawProcessMode === 'string' && processModes.has(rawProcessMode)
    ? rawProcessMode as ProcessMode
    : 'translate';

  const rawProviderId = value.translationProviderId ?? value.providerId;
  const translationProviderId =
    typeof rawProviderId === 'string' && translationProviderIds.has(rawProviderId)
      ? rawProviderId as TranslationProviderId
      : 'deepseek';
  const providerProfiles = normalizeProviderProfiles(value.providerProfiles);

  return {
    schemaVersion: WEB_SETTINGS_SCHEMA_VERSION,
    uiLocale,
    targetLanguage,
    processMode,
    translationProviderId,
    providerProfiles,
  };
}

export function normalizeProviderBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function validateProviderBaseUrl(value: string): string | null {
  const normalized = normalizeProviderBaseUrl(value);
  if (!normalized) return 'Base URL 不能为空';

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return 'Base URL 格式无效';
  }
  if (url.username || url.password) {
    return 'Base URL 不能包含用户名或密码';
  }
  if (url.search || url.hash) {
    return 'Base URL 不能包含查询参数或片段';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') {
    return 'Base URL 必须使用 HTTPS';
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback = (
    hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
  return isLoopback ? null : 'HTTP 仅允许 localhost、127.0.0.0/8 或 ::1';
}

export function normalizeProviderTargetBinding(value: string): string {
  const validationError = validateProviderBaseUrl(value);
  if (validationError) throw new Error(validationError);
  const url = new URL(normalizeProviderBaseUrl(value));
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return `${url.origin}${pathname}`;
}

export function decodeWebSettings(
  serialized: string | null,
  browserLanguage?: string,
): DecodedWebSettings {
  const fallbackLocale = inferUiLocale(browserLanguage);
  if (!serialized) {
    return {
      settings: createDefaultWebSettings(fallbackLocale),
      needsWrite: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {
      settings: createDefaultWebSettings(fallbackLocale),
      needsWrite: true,
    };
  }

  if (!isRecord(parsed)) {
    return {
      settings: createDefaultWebSettings(fallbackLocale),
      needsWrite: true,
    };
  }

  const settings = normalizeWebSettings(parsed, fallbackLocale);
  const needsWrite =
    parsed.schemaVersion !== WEB_SETTINGS_SCHEMA_VERSION
    || parsed.uiLocale !== settings.uiLocale
    || (parsed.targetLanguage ?? parsed.targetLang) !== settings.targetLanguage
    || parsed.processMode !== settings.processMode
    || (parsed.translationProviderId ?? parsed.providerId) !== settings.translationProviderId
    || JSON.stringify(parsed.providerProfiles) !== JSON.stringify(settings.providerProfiles);

  return { settings, needsWrite };
}

export function encodeWebSettings(settings: WebSettings): string {
  return JSON.stringify({
    schemaVersion: WEB_SETTINGS_SCHEMA_VERSION,
    uiLocale: settings.uiLocale,
    targetLanguage: settings.targetLanguage,
    processMode: settings.processMode,
    translationProviderId: settings.translationProviderId,
    providerProfiles: settings.providerProfiles,
  });
}
