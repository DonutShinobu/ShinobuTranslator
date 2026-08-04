import type { ExtensionSettings } from '../../shared/config';

export type ExtensionSettingsState = {
  settings: ExtensionSettings;
  revision: number;
};

export type ExtensionSettingsRepository = {
  read(): Promise<ExtensionSettingsState>;
  update(
    change: (settings: ExtensionSettings) => ExtensionSettings,
    expectedRevision?: number,
  ): Promise<ExtensionSettingsState>;
};

export class ExtensionSettingsRevisionConflictError extends Error {
  readonly code = 'EXTENSION_SETTINGS_REVISION_CONFLICT';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super('扩展设置已在其他页面中更新，请重新加载后再试');
    this.name = 'ExtensionSettingsRevisionConflictError';
  }
}

export function createExtensionSettingsRepository(dependencies: {
  readState(): Promise<ExtensionSettingsState>;
  writeState(state: ExtensionSettingsState): Promise<void>;
}): ExtensionSettingsRepository {
  let mutationTail = Promise.resolve();

  const repository: ExtensionSettingsRepository = {
    read: dependencies.readState,
    update(change, expectedRevision) {
      const mutation = mutationTail.then(async () => {
        const current = await repository.read();
        if (
          expectedRevision !== undefined
          && current.revision !== expectedRevision
        ) {
          throw new ExtensionSettingsRevisionConflictError(
            expectedRevision,
            current.revision,
          );
        }
        const next = {
          settings: change(current.settings),
          revision: current.revision + 1,
        };
        await dependencies.writeState(next);
        return next;
      });
      mutationTail = mutation.then(() => undefined, () => undefined);
      return mutation;
    },
  };
  return repository;
}
