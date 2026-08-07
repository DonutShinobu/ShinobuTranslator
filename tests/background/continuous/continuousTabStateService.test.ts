import { describe, expect, it } from 'vitest';
import { ContinuousTabStateService } from '../../../apps/extension/src/background/continuous/continuousTabStateService';
import type { ExtensionBrowserApi } from '../../../apps/extension/src/shared/extensionRuntime';

describe('ContinuousTabStateService', () => {
  it('continues on same-origin documents and clears state after a cross-origin navigation', async () => {
    const values = new Map<string, unknown>();
    const storageSession = {
      async get(key: string | string[] | Record<string, unknown>) {
        if (this !== storageSession) {
          throw new TypeError(
            'Illegal invocation: Function must be called on an object of type StorageArea',
          );
        }
        return { [key as string]: values.get(key as string) };
      },
      async set(items: Record<string, unknown>) {
        if (this !== storageSession) {
          throw new TypeError(
            'Illegal invocation: Function must be called on an object of type StorageArea',
          );
        }
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      },
      async remove(key: string | string[]) {
        if (this !== storageSession) {
          throw new TypeError(
            'Illegal invocation: Function must be called on an object of type StorageArea',
          );
        }
        for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
      },
    };
    const api: ExtensionBrowserApi = {
      storage: {
        session: storageSession,
      },
    };
    const service = new ContinuousTabStateService(api);
    const reader = {
      tab: { id: 5 },
      documentId: 'document-a',
      origin: 'https://reader.example',
    };

    await service.handle({ operation: 'write', enabled: true }, reader);
    await expect(service.handle({ operation: 'read' }, {
      ...reader,
      documentId: 'document-b',
    })).resolves.toEqual({ enabled: true });
    await expect(service.handle({ operation: 'read' }, {
      ...reader,
      origin: 'https://elsewhere.example',
    })).resolves.toEqual({ enabled: false });

    await service.handle({ operation: 'write', enabled: true }, reader);
    await service.handleNavigation(5, 'https://plain.example/no-reader');
    await expect(service.handle({ operation: 'read' }, reader)).resolves.toEqual({
      enabled: false,
    });
  });
});
