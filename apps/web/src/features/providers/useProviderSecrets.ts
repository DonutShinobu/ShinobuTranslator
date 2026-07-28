import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  translationProviderOptions,
  type TranslationProviderId,
  type WebProviderProfiles,
} from '@shinobu/shared-config';
import {
  createProviderSecretBinding,
  createProviderSecretVault,
  type ProviderSecretVault,
} from '../../security/providerSecretVault';

export type ProviderSecretEntry = {
  value: string;
  persistence: 'none' | 'session' | 'device';
  restoreStatus: 'idle' | 'restoring' | 'target-mismatch' | 'corrupt';
  busy: boolean;
  error?: string;
};

export type ProviderSecretEntries = Record<TranslationProviderId, ProviderSecretEntry>;

const SESSION_PREFIX = 'shinobu:provider-key:';

function initialEntries(): ProviderSecretEntries {
  return Object.fromEntries(translationProviderOptions.map(({ id }) => {
    let value = '';
    try {
      value = sessionStorage.getItem(`${SESSION_PREFIX}${id}`) ?? '';
    } catch {
      // The in-memory state remains usable if sessionStorage is blocked.
    }
    return [id, {
      value,
      persistence: value ? 'session' : 'none',
      restoreStatus: 'idle',
      busy: false,
    }];
  })) as ProviderSecretEntries;
}

function writeSession(providerId: TranslationProviderId, value: string): void {
  try {
    if (value) sessionStorage.setItem(`${SESSION_PREFIX}${providerId}`, value);
    else sessionStorage.removeItem(`${SESSION_PREFIX}${providerId}`);
  } catch {
    // React state is still the source for the active page session.
  }
}

export function useProviderSecrets(
  profiles: WebProviderProfiles,
  vaultOverride?: ProviderSecretVault,
): {
  entries: ProviderSecretEntries;
  update(providerId: TranslationProviderId, value: string): void;
  remember(providerId: TranslationProviderId): Promise<void>;
  forget(providerId: TranslationProviderId): Promise<void>;
  invalidateTarget(providerId: TranslationProviderId): void;
  clear(providerId: TranslationProviderId): Promise<void>;
} {
  const vault = useMemo(
    () => vaultOverride ?? createProviderSecretVault(),
    [vaultOverride],
  );
  const [entries, setEntries] = useState<ProviderSecretEntries>(initialEntries);
  const requestIds = useRef(
    Object.fromEntries(
      translationProviderOptions.map(({ id }) => [id, 0]),
    ) as Record<TranslationProviderId, number>,
  );
  const profileTargets = translationProviderOptions
    .map(({ id }) => `${id}:${profiles[id].baseUrl}`)
    .join('\n');

  useEffect(() => {
    let disposed = false;
    for (const { id } of translationProviderOptions) {
      const current = entries[id];
      if (current.value) continue;
      let binding;
      try {
        binding = createProviderSecretBinding(id, profiles[id].baseUrl);
      } catch {
        continue;
      }
      const requestId = requestIds.current[id] + 1;
      requestIds.current[id] = requestId;
      setEntries((state) => ({
        ...state,
        [id]: {
          ...state[id],
          restoreStatus: 'restoring',
          busy: false,
          error: undefined,
        },
      }));
      void vault.restore(binding)
        .then((result) => {
          if (disposed || requestIds.current[id] !== requestId) return;
          setEntries((state) => {
            if (result.status === 'restored') {
              return {
                ...state,
                [id]: {
                  value: result.secret,
                  persistence: 'device',
                  restoreStatus: 'idle',
                  busy: false,
                },
              };
            }
            return {
              ...state,
              [id]: {
                value: '',
                persistence: 'none',
                restoreStatus: result.status === 'missing' ? 'idle' : result.status,
                busy: false,
              },
            };
          });
        })
        .catch((error) => {
          if (disposed || requestIds.current[id] !== requestId) return;
          setEntries((state) => ({
            ...state,
            [id]: {
              value: '',
              persistence: 'none',
              restoreStatus: 'corrupt',
              busy: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        });
    }
    return () => {
      disposed = true;
    };
    // Entry changes are intentionally excluded: restore is keyed by profile targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileTargets, vault]);

  const update = useCallback((providerId: TranslationProviderId, value: string): void => {
    requestIds.current[providerId] += 1;
    if (entries[providerId].persistence === 'device') {
      void vault.forget(providerId);
    }
    setEntries((state) => ({
      ...state,
      [providerId]: {
        value,
        persistence: value ? 'session' : 'none',
        restoreStatus: 'idle',
        busy: false,
      },
    }));
    writeSession(providerId, value);
  }, [entries, vault]);

  const remember = useCallback(async (providerId: TranslationProviderId): Promise<void> => {
    const entry = entries[providerId];
    const binding = createProviderSecretBinding(providerId, profiles[providerId].baseUrl);
    const requestId = requestIds.current[providerId] + 1;
    requestIds.current[providerId] = requestId;
    setEntries((state) => ({
      ...state,
      [providerId]: {
        ...state[providerId],
        busy: true,
        error: undefined,
      },
    }));
    try {
      await vault.remember(binding, entry.value);
      if (requestIds.current[providerId] !== requestId) {
        await vault.forget(providerId);
        return;
      }
      writeSession(providerId, '');
      setEntries((state) => ({
        ...state,
        [providerId]: {
          value: state[providerId].value,
          persistence: 'device',
          restoreStatus: 'idle',
          busy: false,
        },
      }));
    } catch (error) {
      if (requestIds.current[providerId] !== requestId) return;
      setEntries((state) => ({
        ...state,
        [providerId]: {
          ...state[providerId],
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
  }, [entries, profiles, vault]);

  const forget = useCallback(async (providerId: TranslationProviderId): Promise<void> => {
    const requestId = requestIds.current[providerId] + 1;
    requestIds.current[providerId] = requestId;
    setEntries((state) => ({
      ...state,
      [providerId]: {
        ...state[providerId],
        busy: true,
        error: undefined,
      },
    }));
    try {
      await vault.forget(providerId);
    } catch (error) {
      if (requestIds.current[providerId] !== requestId) return;
      setEntries((state) => ({
        ...state,
        [providerId]: {
          ...state[providerId],
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
    if (requestIds.current[providerId] !== requestId) return;
    setEntries((state) => {
      const value = state[providerId].value;
      writeSession(providerId, value);
      return {
        ...state,
        [providerId]: {
          value,
          persistence: value ? 'session' : 'none',
          restoreStatus: 'idle',
          busy: false,
        },
      };
    });
  }, [vault]);

  const invalidateTarget = useCallback((providerId: TranslationProviderId): void => {
    requestIds.current[providerId] += 1;
    void vault.forget(providerId);
    writeSession(providerId, '');
    setEntries((state) => ({
      ...state,
      [providerId]: {
        value: '',
        persistence: 'none',
        restoreStatus: 'idle',
        busy: false,
      },
    }));
  }, [vault]);

  const clear = useCallback(async (providerId: TranslationProviderId): Promise<void> => {
    requestIds.current[providerId] += 1;
    await vault.forget(providerId);
    writeSession(providerId, '');
    setEntries((state) => ({
      ...state,
      [providerId]: {
        value: '',
        persistence: 'none',
        restoreStatus: 'idle',
        busy: false,
      },
    }));
  }, [vault]);

  return {
    entries,
    update,
    remember,
    forget,
    invalidateTarget,
    clear,
  };
}
