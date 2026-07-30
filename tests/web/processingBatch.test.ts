import { createTranslatorCore } from '@shinobu/translator-core';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import type {
  PipelineConfig,
  PipelineProgress,
} from '../../packages/image-pipeline/src';
import type { WebPipelineRecord } from '../../apps/web/src/domain/pipelineRecord';
import {
  LocalHistory,
  MemoryLocalHistoryAssetAdapter,
  MemoryLocalHistoryIndexAdapter,
  type LocalHistoryClock,
} from '../../apps/web/src/features/history/localHistory';
import {
  MemoryHistoryBatchCoordinator,
  MemoryHistoryCoordinationHub,
} from '../../apps/web/src/features/history/historyCoordination';
import type { ImportedImage } from '../../apps/web/src/features/import/imageImporter';
import {
  createProcessingBatchWorkspace,
  type ProcessingBatch,
  type ProcessingBatchSnapshot,
} from '../../apps/web/src/features/processing/processingBatch';
import {
  ProcessingRuntimeBlockedError,
  type ProcessingRuntime,
} from '../../apps/web/src/features/processing/processingRuntime';
import type {
  WebPipelineInput,
  WebPipelineResult,
  WebTranslatorCore,
} from '../../apps/web/src/runtime/webPipeline';
import { toWebPipelineConfig } from '../../apps/web/src/runtime/webPipelineConfig';

const versions = {
  app: '0.1.0',
  core: '0.8.1',
  model: 'model-v1',
  configSchema: 1,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class StepClock implements LocalHistoryClock {
  private tick = 0;

  now(): Date {
    const value = new Date(Date.UTC(2026, 6, 29, 0, 0, this.tick));
    this.tick += 1;
    return value;
  }
}

function importedImage(id: string, contents = id): ImportedImage {
  return {
    id,
    file: new File([contents], `${id}.png`, { type: 'image/png' }),
    format: 'png',
    width: 1200,
    height: 1800,
    pixelCount: 2_160_000,
    thumbnailUrl: `blob:${id}`,
    duplicate: false,
    workingCopy: {
      required: false,
      width: 1200,
      height: 1800,
      scale: 1,
    },
  };
}

function successfulCore(): WebTranslatorCore {
  const core = createTranslatorCore<
    WebPipelineInput,
    PipelineConfig,
    PipelineProgress,
    WebPipelineResult
  >(async ({ input }) => ({
    status: 'completed',
    image: new Blob([`translated:${input.file.name}`], { type: 'image/png' }),
    providerReports: [],
    summary: {
      image: { width: 1200, height: 1800 },
      detectedRegionCount: 0,
      stageTimings: [],
      runtimeStages: [],
      providerReports: [],
      translationDebug: null,
      ocrDebug: null,
      ocrPostFilterDebug: null,
      typesetDebug: null,
    },
    record: {} as WebPipelineRecord,
  }));
  return {
    ...core,
    dispose: async () => undefined,
  };
}

function readyRuntime(
  getCore: () => WebTranslatorCore,
  admit: (pendingOriginalBytes: number) => Promise<void> = async () => undefined,
  onRelease: () => void = () => undefined,
): ProcessingRuntime {
  const snapshot = {
    status: 'ready',
    environment: { online: true, visibility: 'visible' },
    modelConsent: true,
    capability: {
      ok: true,
      supportLevel: 'desktop',
      backend: 'webgpu',
      workPixelBudget: 8_000_000,
      storagePersistent: true,
      wasmThreads: true,
      webgpu: true,
    },
    modelPackage: {
      status: 'installed',
      storedBytes: 500,
      totalBytes: 500,
    },
    modelProbe: { status: 'ready', provider: 'webgpu' },
    storage: {
      status: 'ready',
      usageBytes: 0,
      quotaBytes: 1_000_000_000,
      availableBytes: 1_000_000_000,
      persisted: true,
    },
  } as const;
  return {
    snapshot: () => structuredClone(snapshot),
    subscribe(listener) {
      listener(structuredClone(snapshot));
      return () => undefined;
    },
    assess: () => ({
      status: 'ready',
      backend: 'webgpu',
      workPixelBudget: 8_000_000,
    }),
    async prepare(request) {
      await admit(request.pendingOriginalBytes);
      const config = toWebPipelineConfig(structuredClone(request.settings));
      let released = false;
      return {
        run(input) {
          if (released) throw new Error('runtime lease released');
          return getCore().run({ input, config });
        },
        admit,
        release() {
          released = true;
          onRelease();
        },
      };
    },
    dispatch: async () => undefined,
  };
}

function waitFor(
  batch: ProcessingBatch,
  predicate: (snapshot: ProcessingBatchSnapshot) => boolean,
): Promise<ProcessingBatchSnapshot> {
  const current = batch.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = batch.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      unsubscribe();
      resolve(snapshot);
    });
  });
}

function setup() {
  const clock = new StepClock();
  const history = new LocalHistory(
    new MemoryLocalHistoryIndexAdapter(),
    new MemoryLocalHistoryAssetAdapter(),
    clock,
    { create: () => 'history-generated-id' },
  );
  const workspace = createProcessingBatchWorkspace({
    history,
    runtime: readyRuntime(successfulCore),
    readThumbnail: async (image) =>
      new Blob([`thumbnail:${image.id}`], { type: 'image/webp' }),
    createId: () => 'batch-1',
  });
  return { history, workspace };
}

describe('processing batch module', () => {
  it('runs an ordinary batch through its public interface and persists no credential', async () => {
    const { history, workspace } = setup();
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];

    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'credential-must-stay-in-memory',
      },
    });

    const completed = await waitFor(batch, (snapshot) => snapshot.status === 'completed');

    expect(completed.tasks).toMatchObject([
      {
        id: 'image-a',
        status: 'done',
        result: { image: { type: 'image/png' } },
      },
    ]);
    const [stored] = await history.list();
    expect(stored).toMatchObject({
      id: 'batch-1',
      status: 'completed',
      items: [{
        id: 'image-a',
        status: 'done',
        thumbnail: { mediaType: 'image/webp' },
      }],
    });
    expect(JSON.stringify(stored)).not.toContain('credential-must-stay-in-memory');
  });

  it('pauses after a result write fault without turning the completed task into a failure', async () => {
    class ResultFailingIndexAdapter extends MemoryLocalHistoryIndexAdapter {
      override async put(batch: Parameters<MemoryLocalHistoryIndexAdapter['put']>[0]) {
        if (batch.items.some((item) => item.status === 'done')) {
          throw new Error('index write failed');
        }
        return super.put(batch);
      }

      override async commit(
        input: Parameters<MemoryLocalHistoryIndexAdapter['commit']>[0],
      ): Promise<void> {
        if (input.putBatch?.items.some((item) => item.status === 'done')) {
          throw new Error('index write failed');
        }
        await super.commit(input);
      }
    }

    const executed: string[] = [];
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async ({ input }) => {
      executed.push(input.file.name);
      return {
        status: 'completed',
        image: new Blob(['translated'], { type: 'image/png' }),
        providerReports: [],
        summary: {
          image: { width: 1200, height: 1800 },
          detectedRegionCount: 0,
          stageTimings: [],
          runtimeStages: [],
          providerReports: [],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
        record: {} as WebPipelineRecord,
      };
    });
    const history = new LocalHistory(
      new ResultFailingIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...core, dispose: async () => undefined })),
      createId: () => 'batch-write-fault',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];

    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    const paused = await waitFor(
      batch,
      (snapshot) => snapshot.persistence.status === 'faulted',
    );

    expect(paused).toMatchObject({
      status: 'paused',
      persistence: {
        status: 'faulted',
        operation: 'store-task-result',
        error: 'index write failed',
      },
      tasks: [
        { id: 'image-a', status: 'done', result: { image: { type: 'image/png' } } },
        { id: 'image-b', status: 'queued' },
      ],
    });
    expect(executed).toEqual(['image-a.png']);
  });

  it('keeps one lazy history batch for a continuous-camera session and drains on close', async () => {
    const { history, workspace } = setup();
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'continuous-camera',
      initialImages: [],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });

    expect(await history.list()).toEqual([]);
    await batch.dispatch({ type: 'append', images: [importedImage('capture-a')] });
    await waitFor(
      batch,
      (snapshot) => snapshot.tasks[0]?.status === 'done',
    );
    expect(batch.snapshot()).toMatchObject({
      status: 'running',
      input: 'open',
    });

    await batch.dispatch({ type: 'append', images: [importedImage('capture-b')] });
    await waitFor(
      batch,
      (snapshot) => snapshot.tasks[1]?.status === 'done',
    );
    await batch.dispatch({ type: 'close-input' });
    const completed = await waitFor(batch, (snapshot) => snapshot.status === 'completed');

    expect(completed.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'capture-a', status: 'done' },
      { id: 'capture-b', status: 'done' },
    ]);
    const stored = await history.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'batch-1',
      status: 'completed',
      items: [
        { id: 'capture-a', status: 'done' },
        { id: 'capture-b', status: 'done' },
      ],
    });
  });

  it('fails closed on an unknown task error and retries the same task identity explicitly', async () => {
    const attempts: string[] = [];
    let failFirstAttempt = true;
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async ({ input }) => {
      attempts.push(input.file.name);
      if (failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error('unclassified pipeline fault');
      }
      return {
        status: 'completed',
        image: new Blob([`translated:${input.file.name}`], { type: 'image/png' }),
        providerReports: [],
        summary: {
          image: { width: 1200, height: 1800 },
          detectedRegionCount: 0,
          stageTimings: [],
          runtimeStages: [],
          providerReports: [],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
        record: {} as WebPipelineRecord,
      };
    });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...core, dispose: async () => undefined })),
      createId: () => 'batch-retry',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });

    const paused = await waitFor(batch, (snapshot) => snapshot.status === 'paused');
    expect(paused.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'failed' },
      { id: 'image-b', status: 'queued' },
    ]);
    expect(attempts).toEqual(['image-a.png']);

    await batch.dispatch({ type: 'retry', taskId: 'image-a' });
    const completed = await waitFor(batch, (snapshot) => snapshot.status === 'completed');

    expect(completed.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'done' },
      { id: 'image-b', status: 'done' },
    ]);
    expect(attempts).toEqual(['image-a.png', 'image-a.png', 'image-b.png']);
  });

  it('continues the batch after an image-scoped failure', async () => {
    const attempts: string[] = [];
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async ({ input }) => {
      attempts.push(input.file.name);
      if (input.file.name === 'image-a.png') {
        throw Object.assign(new Error('unsupported image payload'), {
          code: 'IMAGE_DECODE_FAILED',
          scope: 'image' as const,
          retryable: false,
          messageKey: 'pipeline.failure.imageDecode',
        });
      }
      return {
        status: 'completed',
        image: new Blob(['translated'], { type: 'image/png' }),
        providerReports: [],
        summary: {
          image: { width: 1200, height: 1800 },
          detectedRegionCount: 0,
          stageTimings: [],
          runtimeStages: [],
          providerReports: [],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
        record: {} as WebPipelineRecord,
      };
    });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...core, dispose: async () => undefined })),
      createId: () => 'batch-image-failure',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });

    const completed = await waitFor(
      batch,
      (snapshot) => snapshot.status === 'partially-completed',
    );

    expect(completed.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'failed' },
      { id: 'image-b', status: 'done' },
    ]);
    expect(attempts).toEqual(['image-a.png', 'image-b.png']);
  });

  it('continues after cancelling the current image and finishes as partially completed', async () => {
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async ({ input }, context) => {
      if (input.file.name === 'image-a.png') {
        return new Promise<WebPipelineResult>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      }
      return {
        status: 'completed',
        image: new Blob(['translated'], { type: 'image/png' }),
        providerReports: [],
        summary: {
          image: { width: 1200, height: 1800 },
          detectedRegionCount: 0,
          stageTimings: [],
          runtimeStages: [],
          providerReports: [],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
        record: {} as WebPipelineRecord,
      };
    });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...core, dispose: async () => undefined })),
      createId: () => 'batch-partial',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    await waitFor(
      batch,
      (snapshot) => snapshot.tasks[0]?.status === 'running',
    );

    await batch.dispatch({ type: 'cancel-current' });
    const partiallyCompleted = await waitFor(
      batch,
      (snapshot) => snapshot.status === 'partially-completed',
    );

    expect(partiallyCompleted.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'cancelled' },
      { id: 'image-b', status: 'done' },
    ]);
    const [stored] = await history.list();
    expect(stored.status).toBe('partially-completed');
  });

  it('resumes the same batch identity and runs only queued or interrupted tasks', async () => {
    const executed: string[] = [];
    const baseCore = successfulCore();
    const core: WebTranslatorCore = {
      ...baseCore,
      run(request) {
        executed.push(request.input.file.name);
        return baseCore.run(request);
      },
    };
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'persisted-batch' },
    );
    const settings = createDefaultWebSettings('zh-CN');
    const sourceImages = [
      importedImage('image-a'),
      importedImage('image-b'),
      importedImage('image-c'),
    ];
    const stored = await history.createBatch({
      settings,
      versions,
      items: sourceImages.map((image) => ({
        id: image.id,
        file: image.file,
        width: image.width,
        height: image.height,
        workingCopy: image.workingCopy,
      })),
    });
    await history.updateItem(stored.id, 'image-a', {
      status: 'done',
      result: new Blob(['done'], { type: 'image/png' }),
    });
    await history.updateItem(stored.id, 'image-b', {
      status: 'failed',
      error: 'terminal item failure',
    });
    await history.updateItem(stored.id, 'image-c', {
      status: 'running',
    });
    await history.finishBatch(stored.id, 'paused');

    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => core),
      createId: () => 'must-not-be-used',
    });
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.resume({
      batch: stored,
      images: sourceImages,
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    const partiallyCompleted = await waitFor(
      batch,
      (snapshot) => snapshot.status === 'partially-completed',
    );

    expect(partiallyCompleted.id).toBe('persisted-batch');
    expect(partiallyCompleted.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'done' },
      { id: 'image-b', status: 'failed' },
      { id: 'image-c', status: 'done' },
    ]);
    await expect(partiallyCompleted.tasks[0].result?.image.text()).resolves.toBe('done');
    expect(executed).toEqual(['image-c.png']);
  });

  it('stops the whole batch, keeps remaining work queued, and resumes without retrying cancellation', async () => {
    const executed: string[] = [];
    let releaseCount = 0;
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async ({ input }, context) => {
      executed.push(input.file.name);
      if (input.file.name === 'image-a.png') {
        return new Promise<WebPipelineResult>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      }
      return {
        status: 'completed',
        image: new Blob(['translated'], { type: 'image/png' }),
        providerReports: [],
        summary: {
          image: { width: 1200, height: 1800 },
          detectedRegionCount: 0,
          stageTimings: [],
          runtimeStages: [],
          providerReports: [],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
        record: {} as WebPipelineRecord,
      };
    });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const baseRuntime = readyRuntime(
      () => ({ ...core, dispose: async () => undefined }),
      async () => undefined,
      () => {
        releaseCount += 1;
      },
    );
    let rejectNextPrepare = false;
    const runtime: ProcessingRuntime = {
      ...baseRuntime,
      async prepare(request) {
        if (rejectNextPrepare) {
          rejectNextPrepare = false;
          throw new ProcessingRuntimeBlockedError({
            status: 'blocked',
            code: 'OFFLINE',
          });
        }
        return baseRuntime.prepare(request);
      },
    };
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime,
      createId: () => 'batch-stop',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    await waitFor(batch, (snapshot) => snapshot.tasks[0]?.status === 'running');

    await batch.dispatch({ type: 'stop' });
    const paused = await waitFor(batch, (snapshot) => snapshot.status === 'paused');
    expect(paused.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'cancelled' },
      { id: 'image-b', status: 'queued' },
    ]);
    expect(releaseCount).toBe(1);

    rejectNextPrepare = true;
    await expect(batch.dispatch({ type: 'resume' })).rejects.toMatchObject({
      decision: { code: 'OFFLINE' },
    });
    expect(batch.snapshot()).toMatchObject({
      status: 'paused',
      execution: {
        status: 'faulted',
        code: 'BATCH_EXECUTION_FAILED',
      },
      persistence: { status: 'healthy' },
    });

    await batch.dispatch({ type: 'resume' });
    const completed = await waitFor(
      batch,
      (snapshot) => snapshot.status === 'partially-completed',
    );
    expect(completed.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'cancelled' },
      { id: 'image-b', status: 'done' },
    ]);
    expect(executed).toEqual(['image-a.png', 'image-b.png']);
    expect(releaseCount).toBe(2);
  });

  it('serializes stop and queued edits against a task claim before runtime admission', async () => {
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const claimEntered = deferred<void>();
    const releaseClaim = deferred<void>();
    const updateItem = history.updateItem.bind(history);
    let blockFirstClaim = true;
    vi.spyOn(history, 'updateItem').mockImplementation(async (batchId, itemId, input) => {
      if (blockFirstClaim && input.status === 'running') {
        blockFirstClaim = false;
        claimEntered.resolve();
        await releaseClaim.promise;
      }
      return updateItem(batchId, itemId, input);
    });
    const core = successfulCore();
    const run = vi.spyOn(core, 'run');
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => core),
      createId: () => 'batch-claim-race',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a'), importedImage('image-b')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    await claimEntered.promise;

    await expect(batch.dispatch({
      type: 'remove-queued',
      taskId: 'image-a',
    })).rejects.toThrow('只能移除尚未开始');
    await expect(batch.dispatch({
      type: 'reorder-queued',
      taskIds: ['image-b', 'image-a'],
    })).rejects.toThrow('只能调整尚未开始');
    await expect(batch.dispatch({ type: 'stop' })).resolves.toEqual({
      type: 'batch-stopping',
    });
    expect(batch.snapshot().persistence).toEqual({ status: 'healthy' });

    releaseClaim.resolve();
    const paused = await waitFor(batch, (snapshot) => snapshot.status === 'paused');
    expect(paused).toMatchObject({
      persistence: { status: 'healthy' },
      tasks: [
        { id: 'image-a', status: 'queued' },
        { id: 'image-b', status: 'queued' },
      ],
    });
    const stored = await history.get('batch-claim-race');
    expect(stored).toMatchObject({
      status: 'paused',
      recoveryPoint: { nextItemIndex: 0 },
      items: [
        { id: 'image-a', status: 'queued' },
        { id: 'image-b', status: 'queued' },
      ],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('edits queued tasks through the batch interface while preserving the running task', async () => {
    const core = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async (_request, context) =>
      new Promise<WebPipelineResult>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason),
          { once: true },
        );
      }));
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...core, dispose: async () => undefined })),
      createId: () => 'batch-edit',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [
        importedImage('image-a'),
        importedImage('image-b'),
        importedImage('image-c'),
      ],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    await waitFor(batch, (snapshot) => snapshot.tasks[0]?.status === 'running');

    await batch.dispatch({
      type: 'reorder-queued',
      taskIds: ['image-a', 'image-c', 'image-b'],
    });
    await batch.dispatch({ type: 'remove-queued', taskId: 'image-b' });

    expect(batch.snapshot().tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'running' },
      { id: 'image-c', status: 'queued' },
    ]);
    const [stored] = await history.list();
    expect(stored.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'running' },
      { id: 'image-c', status: 'queued' },
    ]);
    await batch.dispatch({ type: 'stop' });
  });

  it('closes a paused camera session as a terminal batch without retrying its failed task', async () => {
    const failingCore = createTranslatorCore<
      WebPipelineInput,
      PipelineConfig,
      PipelineProgress,
      WebPipelineResult
    >(async () => {
      throw new Error('camera pipeline fault');
    });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    let nextId = 0;
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => ({ ...failingCore, dispose: async () => undefined })),
      createId: () => `camera-${++nextId}`,
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const credential = {
      providerId: settings.translationProviderId,
      target: provider.baseUrl,
      value: 'runtime-only',
    };
    const batch = await workspace.open({
      kind: 'continuous-camera',
      initialImages: [],
      settings,
      versions,
      credential,
    });
    await batch.dispatch({ type: 'append', images: [importedImage('capture-a')] });
    await waitFor(batch, (snapshot) => snapshot.status === 'paused');

    await batch.dispatch({ type: 'close-input' });
    const failed = await waitFor(batch, (snapshot) => snapshot.status === 'failed');
    expect(failed).toMatchObject({
      status: 'failed',
      input: 'closed',
      tasks: [{ id: 'capture-a', status: 'failed' }],
    });

    const nextBatch = await workspace.open({
      kind: 'continuous-camera',
      initialImages: [],
      settings,
      versions,
      credential,
    });
    expect(nextBatch.snapshot().id).toBe('camera-2');
    await nextBatch.dispatch({ type: 'close-input' });
    await waitFor(nextBatch, (snapshot) => snapshot.status === 'completed');
  });

  it('keeps an explicitly open queue batch alive across an idle gap for runtime append', async () => {
    const { history, workspace } = setup();
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      inputLifetime: 'until-closed',
      initialImages: [importedImage('image-a')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });
    await waitFor(batch, (snapshot) => snapshot.tasks[0]?.status === 'done');
    expect(batch.snapshot()).toMatchObject({
      status: 'running',
      input: 'open',
    });

    await batch.dispatch({ type: 'append', images: [importedImage('image-b')] });
    await waitFor(batch, (snapshot) => snapshot.tasks[1]?.status === 'done');
    await batch.dispatch({ type: 'close-input' });
    await waitFor(batch, (snapshot) => snapshot.status === 'completed');

    const [stored] = await history.list();
    expect(stored.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'image-a', status: 'done' },
      { id: 'image-b', status: 'done' },
    ]);
  });

  it('fails closed when execution infrastructure throws before a task can start', async () => {
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'unused' },
    );
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(() => {
        throw new Error('worker factory crashed');
      }),
      createId: () => 'batch-bootstrap-fault',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'queue',
      initialImages: [importedImage('image-a')],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });

    const paused = await waitFor(batch, (snapshot) => snapshot.status === 'paused');
    expect(paused).toMatchObject({
      status: 'paused',
      execution: {
        status: 'faulted',
        code: 'BATCH_EXECUTION_FAILED',
        error: 'worker factory crashed',
      },
      persistence: { status: 'healthy' },
      tasks: [{ id: 'image-a', status: 'queued' }],
    });
    await expect(history.get('batch-bootstrap-fault')).resolves.toMatchObject({
      items: [{ id: 'image-a', status: 'queued' }],
    });
  });

  it('validates resumed image identity before committing the recovery transition', async () => {
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'canonical-batch' },
    );
    const settings = createDefaultWebSettings('zh-CN');
    const providerId = settings.translationProviderId;
    const stored = await history.createBatch({
      settings,
      versions,
      items: [{
        id: 'image-a',
        file: importedImage('image-a').file,
        width: 1200,
        height: 1800,
        workingCopy: {
          required: false,
          width: 1200,
          height: 1800,
          scale: 1,
        },
      }],
    });
    await history.finishBatch(stored.id, 'paused');
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(successfulCore),
    });
    const provider = settings.providerProfiles[providerId];

    await expect(workspace.resume({
      batch: stored,
      images: [],
      settings,
      credential: {
        providerId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    })).rejects.toThrow(/图片与本地历史不一致/u);
    expect((await history.get(stored.id))?.status).toBe('paused');
  });

  it('holds a cross-workbench claim for the active batch lifetime', async () => {
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
      new StepClock(),
      { create: () => 'claimed-batch' },
    );
    const hub = new MemoryHistoryCoordinationHub();
    const owner = new MemoryHistoryBatchCoordinator(hub, 'owner-tab');
    const observer = new MemoryHistoryBatchCoordinator(hub, 'observer-tab');
    const workspace = createProcessingBatchWorkspace({
      history,
      runtime: readyRuntime(successfulCore),
      coordinator: owner,
      createId: () => 'claimed-batch',
    });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const batch = await workspace.open({
      kind: 'continuous-camera',
      initialImages: [],
      settings,
      versions,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    });

    await expect(observer.acquire('claimed-batch')).resolves.toEqual({
      status: 'occupied',
    });

    await batch.dispatch({ type: 'close-input' });
    await waitFor(batch, (snapshot) => snapshot.status === 'completed');
    const acquired = await observer.acquire('claimed-batch');
    expect(acquired.status).toBe('acquired');
    if (acquired.status === 'acquired') acquired.claim.release();
  });

  it.each(['subscribe', 'cleanup'] as const)(
    'fails closed and releases the execution when progress %s throws',
    async (fault) => {
      const history = new LocalHistory(
        new MemoryLocalHistoryIndexAdapter(),
        new MemoryLocalHistoryAssetAdapter(),
        new StepClock(),
        { create: () => 'unused' },
      );
      const delegate = successfulCore();
      let attempt = 0;
      const core: WebTranslatorCore = {
        ...delegate,
        run(request) {
          attempt += 1;
          const execution = delegate.run(request);
          if (attempt > 1) return execution;
          return {
            ...execution,
            progress(listener) {
              if (fault === 'subscribe') throw new Error('progress subscribe crashed');
              const stop = execution.progress(listener);
              return () => {
                stop();
                throw new Error('progress cleanup crashed');
              };
            },
          };
        },
      };
      const workspace = createProcessingBatchWorkspace({
        history,
        runtime: readyRuntime(() => core),
        createId: () => `progress-${fault}`,
      });
      const settings = createDefaultWebSettings('zh-CN');
      const provider = settings.providerProfiles[settings.translationProviderId];
      const batch = await workspace.open({
        kind: 'queue',
        initialImages: [importedImage('image-a')],
        settings,
        versions,
        credential: {
          providerId: settings.translationProviderId,
          target: provider.baseUrl,
          value: 'runtime-only',
        },
      });

      const paused = await waitFor(batch, (snapshot) => snapshot.status === 'paused');
      expect(paused).toMatchObject({
        execution: { status: 'faulted' },
        tasks: [{ id: 'image-a', status: 'queued' }],
      });

      await batch.dispatch({ type: 'resume' });
      const completed = await waitFor(batch, (snapshot) => snapshot.status === 'completed');
      expect(completed.tasks).toMatchObject([{ id: 'image-a', status: 'done' }]);
      expect(attempt).toBe(2);
    },
  );
});
