import { describe, expect, it } from 'vitest';
import { InMemoryPageArtifactStore } from '../../../apps/extension/src/background/continuous/pageArtifactStore';
import {
  InMemoryPageArtifactSessionIndex,
  PageArtifactService,
  StorageSessionPageArtifactSessionIndex,
} from '../../../apps/extension/src/background/continuous/pageArtifactService';
import type { ExtensionBrowserApi } from '../../../apps/extension/src/shared/extensionRuntime';

const sender = {
  tab: { id: 9 },
  documentId: 'document-a',
  frameId: 0,
};

describe('PageArtifactService', () => {
  it('preserves the StorageArea receiver for the persisted session index', async () => {
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
    };
    const api: ExtensionBrowserApi = { storage: { session: storageSession } };
    const index = new StorageSessionPageArtifactSessionIndex(api);
    const sessions = [{
      tabId: 9,
      contentSessionId: 'session-a',
      documentId: 'document-a',
    }];

    await index.write(sessions);

    await expect(index.read()).resolves.toEqual(sessions);
  });

  it('binds refs to the sender tab, document, and registered content session', async () => {
    const service = new PageArtifactService(new InMemoryPageArtifactStore());
    await expect(service.handle({
      operation: 'probe',
      contentSessionId: 'session-a',
    }, sender)).resolves.toEqual({ available: true });

    const ref = await service.handle({
      operation: 'put',
      contentSessionId: 'session-a',
      kind: 'source-snapshot',
      file: {
        base64: btoa('source bytes'),
        contentType: 'image/png',
        filename: 'source.png',
      },
    }, sender);
    expect(ref).toEqual(expect.objectContaining({
      tabId: 9,
      contentSessionId: 'session-a',
      kind: 'source-snapshot',
    }));

    await expect(service.handle({
      operation: 'read',
      contentSessionId: 'session-a',
      ref,
    }, { ...sender, documentId: 'document-b' })).rejects.toThrow(
      '内容会话与消息发送方不匹配',
    );
  });

  it('clears the previous document artifacts when a new session registers in the tab', async () => {
    const store = new InMemoryPageArtifactStore();
    const service = new PageArtifactService(store);
    await service.handle({
      operation: 'probe',
      contentSessionId: 'session-a',
    }, sender);
    const ref = await service.handle({
      operation: 'put',
      contentSessionId: 'session-a',
      kind: 'source-snapshot',
      file: {
        base64: btoa('source bytes'),
        contentType: 'image/png',
        filename: 'source.png',
      },
    }, sender);

    await service.handle({
      operation: 'probe',
      contentSessionId: 'session-b',
    }, { ...sender, documentId: 'document-b' });

    await expect(store.read(ref)).rejects.toThrow('页面产物不存在');
  });

  it('rebinds the sender after a service-worker restart before reading an existing ref', async () => {
    const store = new InMemoryPageArtifactStore();
    const sessionIndex = new InMemoryPageArtifactSessionIndex();
    const firstWorker = new PageArtifactService(store, sessionIndex);
    await firstWorker.handle({ operation: 'probe', contentSessionId: 'session-a' }, sender);
    const ref = await firstWorker.handle({
      operation: 'put',
      contentSessionId: 'session-a',
      kind: 'source-snapshot',
      file: {
        base64: btoa('source bytes'),
        contentType: 'image/png',
        filename: 'source.png',
      },
    }, sender);

    const restartedWorker = new PageArtifactService(store, sessionIndex);
    const file = await restartedWorker.handle({
      operation: 'read',
      contentSessionId: 'session-a',
      ref,
    }, sender);

    expect(atob(file.base64)).toBe('source bytes');
    await restartedWorker.closeTab(9);
    await expect(store.read(ref)).rejects.toThrow('页面产物不存在');
  });

  it('removes orphaned directories from the persisted active-session index on cold start', async () => {
    const store = new InMemoryPageArtifactStore();
    const active = await store.put({
      tabId: 9,
      contentSessionId: 'session-a',
      kind: 'source-snapshot',
      file: new File(['active'], 'active.png'),
    });
    const orphan = await store.put({
      tabId: 10,
      contentSessionId: 'session-orphan',
      kind: 'source-snapshot',
      file: new File(['orphan'], 'orphan.png'),
    });
    const sessionIndex = new InMemoryPageArtifactSessionIndex();
    await sessionIndex.write([{
      tabId: 9,
      contentSessionId: 'session-a',
      documentId: 'document-a',
    }]);

    await new PageArtifactService(store, sessionIndex).initialize();

    await expect((await store.read(active)).text()).resolves.toBe('active');
    await expect(store.read(orphan)).rejects.toThrow('页面产物不存在');
  });
});
