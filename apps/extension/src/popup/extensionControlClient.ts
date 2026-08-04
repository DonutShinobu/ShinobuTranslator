import type {
  ExtensionControlProjection,
  ExtensionInterfacePreferencesPatch,
  ExtensionSettingsProjection,
  ProviderAuthorizationAction,
  ProviderAuthorizationTarget,
} from '../shared/extensionControl';
import type { LlmProvider } from '../shared/config';
import {
  extensionControlChangedEventType,
  extensionControlPortName,
  sendExtensionControlCommand,
  type ExtensionControlChangedEvent,
} from '../shared/extensionControlTransport';
import {
  requireExtensionRuntime,
  type ExtensionRuntime,
} from '../shared/extensionRuntime';

export type ExtensionControlClient = {
  read(): Promise<ExtensionControlProjection>;
  adoptProjection(projection: ExtensionControlProjection): void;
  replaceSettings(settings: ExtensionSettingsProjection): Promise<ExtensionControlProjection>;
  updateInterfacePreferences(
    preferences: ExtensionInterfacePreferencesPatch,
  ): Promise<ExtensionControlProjection>;
  replaceApiKey(provider: LlmProvider, apiKey: string): Promise<ExtensionControlProjection>;
  clearApiKey(provider: LlmProvider): Promise<ExtensionControlProjection>;
  revealApiKey(provider: LlmProvider): Promise<string>;
  performAccess(
    target: ProviderAuthorizationTarget,
    action: ProviderAuthorizationAction,
  ): Promise<ExtensionControlProjection>;
  subscribe(listener: (projection: ExtensionControlProjection) => void): () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => key in right && structurallyEqual(left[key], right[key]));
}

function rebaseValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (structurallyEqual(local, base)) return remote;
  if (!isRecord(base) || !isRecord(local) || !isRecord(remote)) return local;
  const rebased: Record<string, unknown> = { ...remote };
  for (const key of Object.keys(local)) {
    rebased[key] = rebaseValue(base[key], local[key], remote[key]);
  }
  return rebased;
}

export function rebaseExtensionSettingsProjection(
  base: ExtensionSettingsProjection,
  local: ExtensionSettingsProjection,
  remote: ExtensionSettingsProjection,
): ExtensionSettingsProjection {
  return rebaseValue(base, local, remote) as ExtensionSettingsProjection;
}

export function isExtensionSettingsConflict(error: unknown): boolean {
  return isRecord(error) && error.code === 'extension_settings_conflict';
}

export function createExtensionControlClient(
  runtime: ExtensionRuntime = requireExtensionRuntime(),
): ExtensionControlClient {
  let revision = 0;
  let mutationTail = Promise.resolve();

  function remember(projection: ExtensionControlProjection): ExtensionControlProjection {
    revision = Math.max(revision, projection.revision);
    return projection;
  }

  async function expectProjection(
    command: Parameters<typeof sendExtensionControlCommand>[0],
  ): Promise<ExtensionControlProjection> {
    const result = await sendExtensionControlCommand(command, runtime);
    if (result.kind !== 'control-projection') {
      throw new Error('扩展控制操作未返回状态投影');
    }
    return remember(result.projection);
  }

  async function revealApiKey(provider: LlmProvider): Promise<string> {
    const result = await sendExtensionControlCommand({
      kind: 'reveal-api-key',
      provider,
    }, runtime);
    if (result.kind !== 'api-key-disclosure' || result.provider !== provider) {
      throw new Error('扩展控制操作未返回所请求的 API Key');
    }
    return result.apiKey;
  }

  function queueMutation(
    operation: () => Promise<ExtensionControlProjection>,
  ): Promise<ExtensionControlProjection> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    read: () => expectProjection({ kind: 'read' }),
    adoptProjection(projection) {
      remember(projection);
    },
    replaceSettings(settings) {
      return queueMutation(() => expectProjection({
        kind: 'replace-settings',
        settings,
        expectedRevision: revision,
      }));
    },
    updateInterfacePreferences(preferences) {
      return queueMutation(() => expectProjection({
        kind: 'update-interface-preferences',
        preferences,
      }));
    },
    replaceApiKey(provider, apiKey) {
      return queueMutation(() => expectProjection({
        kind: 'replace-api-key',
        provider,
        apiKey,
      }));
    },
    clearApiKey(provider) {
      return queueMutation(() => expectProjection({
        kind: 'clear-api-key',
        provider,
      }));
    },
    revealApiKey,
    performAccess(target, action) {
      return queueMutation(() => expectProjection({
        kind: 'perform-access',
        target,
        action,
      }));
    },
    subscribe(listener) {
      const port = runtime.connect(extensionControlPortName);
      const onMessage = (message: unknown) => {
        if (
          !message
          || typeof message !== 'object'
          || (message as { type?: unknown }).type !== extensionControlChangedEventType
        ) return;
        const event = message as ExtensionControlChangedEvent;
        listener(event.projection);
      };
      port.onMessage.addListener(onMessage);
      return () => {
        port.onMessage.removeListener?.(onMessage);
        port.disconnect();
      };
    },
  };
}
