import type {
  ExtensionControlCommand,
  ExtensionControlProjection,
  ExtensionControlResult,
  ExtensionExecutionSnapshot,
} from '../../shared/extensionControl';
import type { ProviderAccessModule } from './providerAccess';
import type { TranslationConfigurationModule } from './translationConfiguration';

export class ProviderAccessRequiredError extends Error {
  readonly code = 'PROVIDER_ACCESS_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderAccessRequiredError';
  }
}

export type ExtensionControlModule = {
  read(): Promise<ExtensionControlProjection>;
  handle(command: ExtensionControlCommand): Promise<ExtensionControlResult>;
  refreshProviderAccess(): Promise<ExtensionControlProjection>;
  subscribe(listener: (projection: ExtensionControlProjection) => void): () => void;
};

export function createExtensionControlModule(
  configuration: TranslationConfigurationModule,
  access: ProviderAccessModule,
): ExtensionControlModule {
  const listeners = new Set<(projection: ExtensionControlProjection) => void>();

  async function compose(
    refreshAccess = false,
  ): Promise<ExtensionControlProjection> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [configurationProjection, accessProjection] = await Promise.all([
        configuration.read(),
        refreshAccess ? access.refresh() : access.read(),
      ]);
      if (configurationProjection.revision === accessProjection.revision) {
        const { revision: _accessRevision, ...accessState } = accessProjection;
        return {
          revision: configurationProjection.revision,
          settings: configurationProjection.settings,
          access: accessState,
        };
      }
    }
    throw new Error('扩展控制状态持续变化，请重试');
  }

  async function publish(
    projectionPromise: Promise<ExtensionControlProjection>,
  ): Promise<ExtensionControlProjection> {
    const projection = await projectionPromise;
    for (const listener of listeners) listener(projection);
    return projection;
  }

  async function prepareExecution(): Promise<ExtensionExecutionSnapshot> {
    let snapshot: ExtensionExecutionSnapshot | undefined;
    let accessProjection: Awaited<ReturnType<ProviderAccessModule['read']>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      [snapshot, accessProjection] = await Promise.all([
        configuration.prepareExecution(),
        access.read(),
      ]);
      if (snapshot.revision === accessProjection.revision) break;
      snapshot = undefined;
      accessProjection = undefined;
    }
    if (!snapshot || !accessProjection) {
      throw new Error('扩展执行配置持续变化，请重试');
    }
    const provider = snapshot.diagnosticSettings.llmProvider;
    const authMode = snapshot.diagnosticSettings.llmAuthMode;
    if (snapshot.diagnosticSettings.translator !== 'llm') return snapshot;
    if (authMode === 'api_key') {
      const keyState = provider
        ? accessProjection.apiKeys[provider as keyof typeof accessProjection.apiKeys]
        : undefined;
      if (!keyState?.configured) {
        throw new ProviderAccessRequiredError('当前供应商尚未配置 API Key');
      }
    } else if (
      authMode === 'openai_oauth'
      && accessProjection.openAiOAuth.state !== 'ready'
    ) {
      throw new ProviderAccessRequiredError('请先登录 OpenAI');
    } else if (
      authMode === 'gemini_app'
      && accessProjection.geminiApp.state !== 'ready'
    ) {
      throw new ProviderAccessRequiredError('请先登录 Gemini');
    }
    return snapshot;
  }

  const module: ExtensionControlModule = {
    read: () => compose(true),
    async handle(command) {
      if (command.kind === 'prepare-execution') {
        return { kind: 'execution-snapshot', snapshot: await prepareExecution() };
      }
      if (command.kind === 'read') {
        return { kind: 'control-projection', projection: await module.read() };
      }
      let projection: ExtensionControlProjection;
      if (command.kind === 'replace-settings') {
        await configuration.replace(command.settings, command.expectedRevision);
        projection = await publish(compose());
      } else if (command.kind === 'update-interface-preferences') {
        await configuration.updateInterfacePreferences(command.preferences);
        projection = await publish(compose());
      } else if (command.kind === 'replace-api-key') {
        await access.replaceApiKey(command.provider, command.apiKey);
        projection = await publish(compose());
      } else if (command.kind === 'clear-api-key') {
        await access.clearApiKey(command.provider);
        projection = await publish(compose());
      } else {
        await access.perform(command.target, command.action);
        projection = await publish(compose());
      }
      return { kind: 'control-projection', projection };
    },
    refreshProviderAccess() {
      return publish(compose(true));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return module;
}
