import { describe, expect, it, vi } from 'vitest';

import { createDefaultWebSettings } from '../../packages/shared-config/src';
import type { LocalHistoryBatch } from '../../apps/web/src/features/history/localHistory';
import type {
  HistoryIntent,
  HistoryOutcome,
  LocalHistoryLifecycle,
  LocalHistoryWorkbenchAdapter,
} from '../../apps/web/src/features/history/localHistoryLifecycle';
import type { ImportedImage } from '../../apps/web/src/features/import/imageImporter';
import type {
  ProcessingBatch,
  ProcessingBatchCommand,
  ProcessingBatchCommandResult,
  ProcessingBatchSnapshot,
  ProcessingBatchWorkspace,
} from '../../apps/web/src/features/processing/processingBatch';
import type { ProcessingRuntime } from '../../apps/web/src/features/processing/processingRuntime';
import { createWebWorkbench } from '../../apps/web/src/features/workbench/webWorkbench';

const TEST_VERSIONS = {
  app: '0.1.0',
  core: '0.8.1',
  model: 'model-v1',
  configSchema: 1,
} as const;

const emptyImporter = () => ({
  importFiles: async () => ({ accepted: [], rejected: [] }),
});

function importedImage(id: string, thumbnailUrl: string): ImportedImage {
  return {
    id,
    file: new File(['image'], `${id}.png`, { type: 'image/png' }),
    format: 'png',
    width: 100,
    height: 80,
    pixelCount: 8_000,
    thumbnailUrl,
    duplicate: false,
    workingCopy: {
      required: false,
      width: 100,
      height: 80,
      scale: 1,
    },
  };
}

function batchSnapshot(
  id: string,
  status: ProcessingBatchSnapshot['status'] = 'running',
): ProcessingBatchSnapshot {
  return {
    id,
    kind: 'queue',
    status,
    input: 'closed',
    execution: { status: 'healthy' },
    persistence: { status: 'healthy' },
    tasks: [{ id: 'image-1', status: status === 'completed' ? 'done' : 'queued' }],
  };
}

class FakeProcessingBatch implements ProcessingBatch {
  private current: ProcessingBatchSnapshot;
  private readonly listeners = new Set<(snapshot: ProcessingBatchSnapshot) => void>();
  private readonly historicalListeners: Array<(snapshot: ProcessingBatchSnapshot) => void> = [];

  constructor(
    id: string,
    private readonly applyCommand: (
      command: ProcessingBatchCommand,
    ) => Promise<ProcessingBatchCommandResult> = async () => ({ type: 'batch-stopping' }),
    initialSnapshot: ProcessingBatchSnapshot = batchSnapshot(id),
  ) {
    this.current = initialSnapshot;
  }

  snapshot(): ProcessingBatchSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: ProcessingBatchSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.historicalListeners.push(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  dispatch(command: ProcessingBatchCommand): Promise<ProcessingBatchCommandResult> {
    return this.applyCommand(command);
  }

  emit(snapshot: ProcessingBatchSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  emitLate(snapshot: ProcessingBatchSnapshot): void {
    for (const listener of this.historicalListeners) listener(snapshot);
  }
}

function processingWorkspace(batches: ProcessingBatch[]): ProcessingBatchWorkspace {
  return {
    async open() {
      const next = batches.shift();
      if (!next) throw new Error('No processing batch prepared');
      return next;
    },
    async resume() {
      const next = batches.shift();
      if (!next) throw new Error('No processing batch prepared');
      return next;
    },
  };
}

function historyBatch(): LocalHistoryBatch {
  return {
    schemaVersion: 3,
    id: 'history-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    status: 'paused',
    rerunnable: true,
    lockedConfig: {
      schemaVersion: 1,
      targetLanguage: 'zh-CHS',
      processMode: 'translate',
      provider: {
        id: 'openai',
        target: 'https://example.com/v1',
        model: 'model',
      },
    },
    versions: {
      app: '0.1.0',
      core: '0.8.1',
      model: 'model-v1',
      configSchema: 1,
    },
    recoveryPoint: {
      savedAt: '2026-08-01T00:00:00.000Z',
      nextItemIndex: 0,
    },
    items: [{
      id: 'history-image-1',
      order: 0,
      width: 100,
      height: 80,
      workingCopy: {
        required: false,
        width: 100,
        height: 80,
        scale: 1,
      },
      status: 'queued',
      original: {
        path: 'history-1/items/0/original',
        fileName: 'history.png',
        mediaType: 'image/png',
        size: 5,
      },
    }],
  };
}

function fakeHistoryRuntime(
  request: (
    adapter: LocalHistoryWorkbenchAdapter,
    intent: HistoryIntent,
  ) => Promise<HistoryOutcome>,
  processing: ProcessingBatchWorkspace = processingWorkspace([]),
  processingRuntime: ProcessingRuntime = fakeProcessingRuntime(),
): (adapter: LocalHistoryWorkbenchAdapter) => {
  lifecycle: LocalHistoryLifecycle;
  processing: ProcessingBatchWorkspace;
  processingRuntime: ProcessingRuntime;
  dispose(): void;
} {
  return (adapter) => ({
    lifecycle: {
      snapshot: () => ({ status: 'ready', entries: [], busy: false, faults: [] }),
      subscribe: () => () => undefined,
      request: (intent) => request(adapter, intent),
      dispose: () => undefined,
    },
    processing,
    processingRuntime,
    dispose: () => undefined,
  });
}

function fakeProcessingRuntime(): ProcessingRuntime {
  return {
    snapshot: () => ({
      status: 'ready',
      environment: { online: true, visibility: 'visible' },
      modelConsent: true,
      capability: {
        ok: true,
        supportLevel: 'desktop',
        backend: 'wasm',
        workPixelBudget: 6_000_000,
        storagePersistent: true,
        wasmThreads: false,
        webgpu: false,
      },
      modelPackage: {
        status: 'installed',
        storedBytes: 1,
        totalBytes: 1,
      },
      modelProbe: { status: 'ready', provider: 'wasm' },
      storage: {
        status: 'ready',
        persisted: true,
        quotaBytes: 1_000_000_000,
        usageBytes: 0,
        availableBytes: 1_000_000_000,
      },
    }),
    subscribe: () => () => undefined,
    assess: () => ({ status: 'ready', backend: 'wasm', workPixelBudget: 6_000_000 }),
    prepare: async () => {
      throw new Error('Fake processing workspace does not prepare runtime leases');
    },
    dispatch: async () => undefined,
  };
}

describe('web workbench', () => {
  it('keeps construction render-pure and initializes its browser runtime once on use', () => {
    const createRuntime = vi.fn(fakeHistoryRuntime(async () => ({
      status: 'succeeded',
      type: 'refreshed',
    })));
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: emptyImporter,
      createRuntime,
      versions: TEST_VERSIONS,
    });

    expect(createRuntime).not.toHaveBeenCalled();
    const unsubscribeFirst = workbench.subscribe(() => undefined);
    const unsubscribeSecond = workbench.subscribe(() => undefined);

    expect(createRuntime).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('creates the sole draft when images are added and releases their URLs on dispose', async () => {
    const revokeObjectURL = vi.fn();
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [
            importedImage('image-1', 'blob:thumbnail-1'),
            importedImage('image-2', 'blob:thumbnail-2'),
          ],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(async () => ({
        status: 'succeeded',
        type: 'refreshed',
      })),
      versions: TEST_VERSIONS,
      urls: {
        createObjectURL: vi.fn(() => 'blob:result'),
        revokeObjectURL,
      },
    });

    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['one'], 'one.png'), new File(['two'], 'two.png')],
    });

    expect(workbench.snapshot()).toMatchObject({
      phase: 'draft',
      selectedImageId: 'image-1',
      images: [{ id: 'image-1' }, { id: 'image-2' }],
    });

    await workbench.dispose();

    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual([
      'blob:result',
      'blob:thumbnail-1',
      'blob:thumbnail-2',
    ]);
  });

  it('assesses runtime readiness without admitting provider secrets into the module', async () => {
    const processingRuntime = fakeProcessingRuntime();
    const assess = vi.fn(processingRuntime.assess);
    processingRuntime.assess = assess;
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: emptyImporter,
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([]),
        processingRuntime,
      ),
      versions: TEST_VERSIONS,
    });

    await workbench.dispatch({
      type: 'assess-runtime',
      target: 'queue',
      credential: {
        providerId: 'deepseek',
        target: 'https://example.com/v1',
        available: true,
      },
      pendingOriginalBytes: 0,
    });

    expect(assess).toHaveBeenCalledWith({
      settings: workbench.snapshot().settings,
      credential: {
        providerId: 'deepseek',
        target: 'https://example.com/v1',
        available: true,
      },
      pendingOriginalBytes: 0,
    });
    expect(assess.mock.calls[0][0].credential).not.toHaveProperty('value');
  });

  it('rolls back a failed recovery preparation without creating a second workbench state', async () => {
    const revokeObjectURL = vi.fn();
    const currentSettings = createDefaultWebSettings('zh-TW');
    const source = historyBatch();
    const workbench = createWebWorkbench({
      initialSettings: currentSettings,
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('temporary', 'blob:temporary')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(async (adapter, intent) => {
        if (intent.type !== 'prepare-resume') throw new Error('Unexpected intent');
        try {
          await adapter.installRecovery({
            kind: 'recovery',
            batch: {
              ...source,
              items: [...source.items, { ...source.items[0], id: 'history-image-2', order: 1 }],
            },
            files: [
              new File(['one'], 'one.png'),
              new File(['two'], 'two.png'),
            ],
          });
          return { status: 'succeeded', type: 'recovery-prepared', batchId: source.id };
        } catch (error) {
          return {
            status: 'failed',
            operation: 'prepare-resume',
            cause: error instanceof Error ? error.message : String(error),
          };
        }
      }),
      versions: TEST_VERSIONS,
      urls: {
        createObjectURL: vi.fn(() => 'blob:result'),
        revokeObjectURL,
      },
    });

    const outcome = await workbench.dispatch({
      type: 'history',
      intent: { type: 'prepare-resume', batchId: source.id },
    });

    expect(outcome).toMatchObject({ status: 'failed', operation: 'prepare-resume' });
    expect(workbench.snapshot()).toMatchObject({
      phase: 'empty',
      settings: currentSettings,
      images: [],
    });
    expect(workbench.snapshot().recoveryBatchId).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:temporary');
  });

  it('installs history recovery atomically and restores only locked processing settings', async () => {
    const source = historyBatch();
    const currentSettings = createDefaultWebSettings('zh-TW');
    currentSettings.providerProfiles.deepseek.model = 'keep-current-model';
    const workbench = createWebWorkbench({
      initialSettings: currentSettings,
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('temporary', 'blob:history-thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(async (adapter, intent) => {
        if (intent.type === 'prepare-resume') {
          await adapter.installRecovery({
            kind: 'recovery',
            batch: source,
            files: [new File(['image'], 'history.png')],
          });
          return { status: 'succeeded', type: 'recovery-prepared', batchId: source.id };
        }
        if (intent.type === 'discard-recovery') {
          adapter.discardRecovery(intent.batchId);
          return { status: 'succeeded', type: 'recovery-discarded', batchId: intent.batchId };
        }
        throw new Error('Unexpected intent');
      }),
      versions: TEST_VERSIONS,
    });
    const observed: Array<{ phase: string; imageCount: number }> = [];
    const unsubscribe = workbench.subscribe(() => {
      const snapshot = workbench.snapshot();
      observed.push({ phase: snapshot.phase, imageCount: snapshot.images.length });
    });

    await workbench.dispatch({
      type: 'history',
      intent: { type: 'prepare-resume', batchId: source.id },
    });

    expect(workbench.snapshot()).toMatchObject({
      phase: 'recovery',
      recoveryBatchId: 'history-1',
      selectedImageId: 'history-image-1',
      images: [{ id: 'history-image-1' }],
      settings: {
        uiLocale: 'zh-TW',
        translationProviderId: 'openai',
        providerProfiles: {
          deepseek: { model: 'keep-current-model' },
          openai: {
            baseUrl: 'https://example.com/v1',
            model: 'model',
          },
        },
      },
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['second'], 'second.png')],
    });
    expect(workbench.snapshot()).toMatchObject({
      phase: 'recovery',
      images: [{ id: 'history-image-1' }],
    });
    expect(observed).not.toContainEqual({ phase: 'empty', imageCount: 1 });

    const localeUpdate = structuredClone(workbench.snapshot().settings);
    localeUpdate.uiLocale = 'zh-CN';
    await workbench.dispatch({ type: 'update-settings', settings: localeUpdate });
    expect(workbench.snapshot().settings.uiLocale).toBe('zh-CN');

    const forbiddenUpdate = structuredClone(workbench.snapshot().settings);
    forbiddenUpdate.processMode = 'erase';
    await workbench.dispatch({ type: 'update-settings', settings: forbiddenUpdate });
    expect(workbench.snapshot().settings.processMode).toBe('translate');

    const unlockedUpdate = structuredClone(workbench.snapshot().settings);
    unlockedUpdate.providerProfiles.glm.model = 'updated-while-locked';
    await workbench.dispatch({ type: 'update-settings', settings: unlockedUpdate });
    expect(workbench.snapshot().settings.providerProfiles.glm.model)
      .toBe('updated-while-locked');

    await workbench.dispatch({ type: 'exit-recovery' });
    expect(workbench.snapshot()).toMatchObject({
      phase: 'empty',
      settings: {
        uiLocale: 'zh-CN',
        translationProviderId: 'deepseek',
        providerProfiles: { glm: { model: 'updated-while-locked' } },
      },
    });
    unsubscribe();
  });

  it('creates an editable history draft that requires a current provider selection', async () => {
    const source = historyBatch();
    source.lockedConfig.provider.id = 'removed-provider';
    const currentSettings = createDefaultWebSettings('zh-CN');
    const workbench = createWebWorkbench({
      initialSettings: currentSettings,
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('draft-image', 'blob:draft-thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(async (adapter, intent) => {
        if (intent.type !== 'prepare-clone') throw new Error('Unexpected intent');
        await adapter.installDraft({
          kind: 'draft',
          sourceBatch: source,
          files: [new File(['image'], 'history.png')],
          providerSelectionRequired: true,
        });
        return {
          status: 'succeeded',
          type: 'draft-prepared',
          batchId: source.id,
          providerSelectionRequired: true,
        };
      }),
      versions: TEST_VERSIONS,
    });

    await workbench.dispatch({
      type: 'history',
      intent: { type: 'prepare-clone', batchId: source.id },
    });

    expect(workbench.snapshot()).toMatchObject({
      phase: 'draft',
      draftProviderSelectionRequired: true,
      settings: {
        uiLocale: 'zh-CN',
        translationProviderId: currentSettings.translationProviderId,
        targetLanguage: 'zh-CHS',
        processMode: 'translate',
      },
    });
  });

  it('rolls back a started recovery batch when history handoff fails', async () => {
    const source = historyBatch();
    const commands: ProcessingBatchCommand['type'][] = [];
    let batch: FakeProcessingBatch;
    batch = new FakeProcessingBatch('history-1', async (command) => {
      commands.push(command.type);
      if (command.type === 'stop') {
        batch.emit({ ...batch.snapshot(), status: 'paused' });
        throw new Error('recovery persistence failed');
      }
      if (command.type === 'detach') return { type: 'batch-detached' };
      return { type: 'batch-stopping' };
    });
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('temporary', 'blob:history-thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(async (adapter, intent) => {
        if (intent.type === 'prepare-resume') {
          await adapter.installRecovery({
            kind: 'recovery',
            batch: source,
            files: [new File(['image'], 'history.png')],
          });
          return { status: 'succeeded', type: 'recovery-prepared', batchId: source.id };
        }
        if (intent.type === 'handoff-recovery') {
          return { status: 'failed', operation: 'handoff-recovery', cause: 'handoff failed' };
        }
        return { status: 'succeeded', type: 'refreshed' };
      }, processingWorkspace([batch])),
      versions: source.versions,
    });
    await workbench.dispatch({
      type: 'history',
      intent: { type: 'prepare-resume', batchId: source.id },
    });

    await expect(workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'openai', target: 'https://example.com', value: 'secret' },
    })).rejects.toThrow('handoff failed');

    expect(commands).toEqual(['stop', 'detach']);
    expect(workbench.snapshot()).toMatchObject({
      phase: 'recovery',
      recoveryBatchId: 'history-1',
      activeBatch: undefined,
      jobs: { 'history-image-1': { status: 'queued' } },
    });
  });

  it('ignores terminal events from an old batch after a new batch is attached', async () => {
    const first = new FakeProcessingBatch('batch-1');
    const second = new FakeProcessingBatch('batch-2');
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('image-1', 'blob:thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([first, second]),
      ),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['image'], 'image.png')],
    });

    await workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });
    first.emit(batchSnapshot('batch-1', 'completed'));
    await workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });

    first.emitLate(batchSnapshot('batch-1', 'failed'));

    expect(workbench.snapshot()).toMatchObject({
      phase: 'processing',
      activeBatch: { id: 'batch-2', status: 'running' },
    });
  });

  it('refreshes owned runtime storage directly when a batch settles', async () => {
    const batch = new FakeProcessingBatch('batch-1');
    const processingRuntime = fakeProcessingRuntime();
    const runtimeDispatch = vi.fn(processingRuntime.dispatch);
    processingRuntime.dispatch = runtimeDispatch;
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('image-1', 'blob:thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([batch]),
        processingRuntime,
      ),
      versions: TEST_VERSIONS,
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['image'], 'image.png')],
    });
    await workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });
    runtimeDispatch.mockClear();

    batch.emit(batchSnapshot('batch-1', 'completed'));

    expect(runtimeDispatch).toHaveBeenCalledWith({ type: 'refresh-storage' });
  });

  it('closes an idle queue input so the processing batch can reach a terminal state', async () => {
    const commands: ProcessingBatchCommand['type'][] = [];
    const batch = new FakeProcessingBatch('batch-1', async (command) => {
      commands.push(command.type);
      return { type: 'input-closed' };
    }, {
      ...batchSnapshot('batch-1'),
      input: 'open',
    });
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('image-1', 'blob:thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([batch]),
      ),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['image'], 'image.png')],
    });
    await workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });

    batch.emit({
      ...batch.snapshot(),
      tasks: [{ id: 'image-1', status: 'done' }],
    });
    await vi.waitFor(() => expect(commands).toContain('close-input'));
  });

  it('does not open continuous camera while an editable draft exists', async () => {
    const cameraBatch = new FakeProcessingBatch('camera-batch');
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('image-1', 'blob:thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([cameraBatch]),
      ),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['image'], 'image.png')],
    });

    await expect(workbench.dispatch({
      type: 'open-camera',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    })).rejects.toThrow('empty workbench');
    expect(workbench.snapshot().phase).toBe('draft');
    expect(workbench.snapshot().activeBatch).toBeUndefined();
  });

  it('serializes concurrent commands sent to the active batch', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const releases: Array<() => void> = [];
    const batch = new FakeProcessingBatch('batch-1', async (command) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return command.type === 'stop'
        ? { type: 'batch-stopping' }
        : { type: 'batch-resumed' };
    });
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('image-1', 'blob:thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([batch]),
      ),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
    });
    await workbench.dispatch({
      type: 'import-files',
      files: [new File(['image'], 'image.png')],
    });
    await workbench.dispatch({
      type: 'start-processing',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });

    const stopping = workbench.dispatch({ type: 'batch-command', command: { type: 'stop' } });
    const resuming = workbench.dispatch({ type: 'batch-command', command: { type: 'resume' } });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await Promise.all([stopping, resuming]);

    expect(maximumInFlight).toBe(1);
  });

  it('lets model cancellation preempt a long-running runtime command', async () => {
    const processingRuntime = fakeProcessingRuntime();
    const commands: string[] = [];
    let finishInstall: (() => void) | undefined;
    processingRuntime.dispatch = vi.fn(async (command) => {
      commands.push(command.type);
      if (command.type === 'accept-model-download') {
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        });
      }
      if (command.type === 'cancel-model-download') finishInstall?.();
    });
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: emptyImporter,
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([]),
        processingRuntime,
      ),
      versions: TEST_VERSIONS,
    });
    const unsubscribe = workbench.subscribe(() => undefined);
    await Promise.resolve();
    commands.length = 0;

    const installation = workbench.dispatch({
      type: 'runtime-command',
      command: { type: 'accept-model-download' },
    });
    await vi.waitFor(() => expect(commands).toEqual(['accept-model-download']));
    const cancellation = workbench.dispatch({
      type: 'runtime-command',
      command: { type: 'cancel-model-download' },
    });

    await vi.waitFor(() => expect(commands).toEqual([
      'accept-model-download',
      'cancel-model-download',
    ]));
    await Promise.all([installation, cancellation]);
    unsubscribe();
  });

  it('requests runtime disposal before waiting for queued work', async () => {
    const processingRuntime = fakeProcessingRuntime();
    const commands: string[] = [];
    let finishInstall: (() => void) | undefined;
    processingRuntime.dispatch = vi.fn(async (command) => {
      commands.push(command.type);
      if (command.type === 'accept-model-download') {
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        });
      }
      if (command.type === 'dispose') finishInstall?.();
    });
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: emptyImporter,
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([]),
        processingRuntime,
      ),
      versions: TEST_VERSIONS,
    });
    const unsubscribe = workbench.subscribe(() => undefined);
    await Promise.resolve();
    commands.length = 0;
    const installation = workbench.dispatch({
      type: 'runtime-command',
      command: { type: 'accept-model-download' },
    });
    await vi.waitFor(() => expect(commands).toEqual(['accept-model-download']));

    const disposal = workbench.dispose();

    await vi.waitFor(() => expect(commands).toEqual(['accept-model-download', 'dispose']));
    await Promise.all([installation, disposal]);
    unsubscribe();
  });

  it('owns the continuous-camera round and releases its original and result URLs', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:camera-original')
      .mockReturnValueOnce('blob:camera-result');
    const revokeObjectURL = vi.fn();
    let batch: FakeProcessingBatch;
    batch = new FakeProcessingBatch(
      'camera-batch',
      async (command) => {
        if (command.type === 'append') {
          const image = command.images[0];
          setTimeout(() => batch.emit({
            ...batch.snapshot(),
            tasks: [{
              id: image.id,
              status: 'done',
              result: { image: new Blob(['translated'], { type: 'image/png' }) },
            }],
          }), 0);
          return { type: 'appended', taskIds: [image.id] };
        }
        return { type: 'input-closed' };
      },
      {
        ...batchSnapshot('camera-batch'),
        kind: 'continuous-camera',
        input: 'open',
        tasks: [],
      },
    );
    const workbench = createWebWorkbench({
      initialSettings: createDefaultWebSettings('zh-CN'),
      importer: () => ({
        importFiles: async () => ({
          accepted: [importedImage('camera-image', 'blob:camera-thumbnail')],
          rejected: [],
        }),
      }),
      createRuntime: fakeHistoryRuntime(
        async () => ({ status: 'succeeded', type: 'refreshed' }),
        processingWorkspace([batch]),
      ),
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
      urls: { createObjectURL, revokeObjectURL },
    });

    await workbench.dispatch({
      type: 'open-camera',
      credential: { providerId: 'deepseek', target: 'https://example.com', value: 'secret' },
    });
    await workbench.dispatch({
      type: 'capture-camera',
      file: new File(['capture'], 'capture.jpg', { type: 'image/jpeg' }),
    });
    await vi.waitFor(() => {
      expect(workbench.snapshot().camera.round.status).toBe('done');
    });

    expect(workbench.snapshot().camera).toEqual({
      open: true,
      round: {
        status: 'done',
        originalUrl: 'blob:camera-original',
        resultUrl: 'blob:camera-result',
      },
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:camera-thumbnail');

    await workbench.dispatch({ type: 'next-camera' });

    expect(workbench.snapshot().camera.round).toEqual({ status: 'ready' });
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual([
      'blob:camera-thumbnail',
      'blob:camera-original',
      'blob:camera-result',
    ]);
  });
});
