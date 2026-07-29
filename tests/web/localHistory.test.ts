import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import {
  LocalHistory,
  MemoryLocalHistoryAssetAdapter,
  MemoryLocalHistoryIndexAdapter,
  type LocalHistoryClock,
} from '../../apps/web/src/features/history/localHistory';

const versions = {
  app: '0.1.0',
  core: '0.8.1',
  model: 'model-v1',
  configSchema: 1,
};

function file(name: string, contents: string): File {
  return new File([contents], name, { type: 'image/png' });
}

function inputItems() {
  return [
    {
      id: 'image-a',
      file: file('one.png', 'original-one'),
      thumbnail: new Blob(['thumb-one'], { type: 'image/webp' }),
      width: 1200,
      height: 1800,
      workingCopy: {
        required: false,
        width: 1200,
        height: 1800,
        scale: 1,
      },
    },
    {
      id: 'image-b',
      file: file('two.png', 'original-two'),
      width: 800,
      height: 1000,
      workingCopy: {
        required: true,
        width: 640,
        height: 800,
        scale: 0.8,
      },
    },
  ];
}

class StepClock implements LocalHistoryClock {
  private tick = 0;

  now(): Date {
    const value = new Date(Date.UTC(2026, 6, 28, 0, 0, this.tick));
    this.tick += 1;
    return value;
  }
}

function setup() {
  const index = new MemoryLocalHistoryIndexAdapter();
  const assets = new MemoryLocalHistoryAssetAdapter();
  const history = new LocalHistory(
    index,
    assets,
    new StepClock(),
    { create: () => 'batch-1' },
  );
  return { history, index, assets };
}

describe('local history module', () => {
  it('stores only the locked processing configuration selected for the batch', async () => {
    const { history } = setup();
    const settings = createDefaultWebSettings('zh-TW');
    settings.translationProviderId = 'openai';
    settings.providerProfiles.openai = {
      baseUrl: 'https://example.test/v1/',
      model: 'chosen-model',
    };
    settings.providerProfiles.deepseek.model = 'must-not-be-stored';

    const batch = await history.createBatch({
      settings,
      versions,
      items: inputItems().slice(0, 1),
    });

    expect(batch.lockedConfig).toEqual({
      schemaVersion: 1,
      targetLanguage: 'zh-CHT',
      processMode: 'translate',
      provider: {
        id: 'openai',
        target: 'https://example.test/v1',
        model: 'chosen-model',
      },
    });
    expect(JSON.stringify(batch)).not.toContain('uiLocale');
    expect(JSON.stringify(batch)).not.toContain('must-not-be-stored');
  });

  it('commits ordered metadata only after originals and thumbnails are stored', async () => {
    const { history, assets } = setup();
    const settings = createDefaultWebSettings('zh-CN');
    const batch = await history.createBatch({
      settings,
      versions,
      items: inputItems(),
    });

    expect(batch).toMatchObject({
      schemaVersion: 3,
      id: 'batch-1',
      status: 'running',
      rerunnable: true,
      recoveryPoint: { nextItemIndex: 0 },
    });
    expect(batch.items.map(({ id, order, status }) => ({ id, order, status }))).toEqual([
      { id: 'image-a', order: 0, status: 'queued' },
      { id: 'image-b', order: 1, status: 'queued' },
    ]);
    expect(await assets.get(batch.items[0].original!.path)).toHaveProperty(
      'size',
      'original-one'.length,
    );
    expect(await assets.get(batch.items[0].thumbnail!.path)).toHaveProperty(
      'size',
      'thumb-one'.length,
    );
    expect(JSON.stringify(batch)).not.toContain('apiKey');
  });

  it('reads legacy v1 metadata and upgrades it on the next write', async () => {
    const { history, index } = setup();
    const created = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    await index.put({ ...created, schemaVersion: 1 });

    expect((await history.list())[0].schemaVersion).toBe(3);
    await history.saveRecoveryPoint(created.id, 0, 'paused');
    expect((await index.get(created.id))?.schemaVersion).toBe(3);
  });

  it('rejects invalid or too-new locked processing configuration at the storage boundary', async () => {
    const { history, index } = setup();
    const created = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    await index.put({
      ...created,
      lockedConfig: {
        ...created.lockedConfig,
        schemaVersion: 99,
      } as unknown as typeof created.lockedConfig,
    });

    await expect(history.get(created.id)).rejects.toThrow(/锁定处理配置/u);
    await expect(history.list()).rejects.toThrow(/锁定处理配置/u);
  });

  it('records results and versioned recovery points without changing the original settings', async () => {
    const { history } = setup();
    const settings = createDefaultWebSettings('zh-TW');
    const batch = await history.createBatch({
      settings,
      versions,
      items: inputItems(),
    });
    settings.targetLanguage = 'zh-CHS';

    await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['translated'], { type: 'image/png' }),
      summary: { ocrRegions: 3 },
    });
    await history.updateItem(batch.id, 'image-b', {
      status: 'failed',
      error: 'OCR failed',
    });
    await history.saveRecoveryPoint(batch.id, 1, 'paused');
    const finished = await history.finishBatch(batch.id, 'failed');

    expect(finished.lockedConfig.targetLanguage).toBe('zh-CHT');
    expect(finished.status).toBe('failed');
    expect(finished.items[0]).toMatchObject({
      status: 'done',
      summary: { ocrRegions: 3 },
      result: { fileName: 'one.png', mediaType: 'image/png', size: 10 },
    });
    expect(finished.items[1]).toMatchObject({
      status: 'failed',
      error: 'OCR failed',
    });
    expect(finished.recoveryPoint.nextItemIndex).toBe(2);
  });

  it('marks missing or truncated assets as partial while preserving accessible content', async () => {
    const { history, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    await assets.delete(batch.items[0].original!.path);

    const inspection = await history.inspect(batch.id);

    expect(inspection?.integrity).toBe('partial');
    expect(inspection?.missingAssets).toEqual([batch.items[0].original!.path]);
    expect(inspection?.batch.items[1].original).toBeDefined();
  });

  it('can keep only results and permanently mark a batch as non-rerunnable', async () => {
    const { history, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    const withResult = await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['result'], { type: 'image/png' }),
    });
    const resultPath = withResult.items[0].result!.path;

    const compacted = await history.keepResultsOnly(batch.id);

    expect(compacted.rerunnable).toBe(false);
    expect(compacted.items.every((item) => !item.original && !item.thumbnail)).toBe(true);
    expect(await assets.get(resultPath)).toHaveProperty('size', 6);
  });

  it('commits results-only state and retries persistent cleanup debt', async () => {
    class FailingDeleteAssets extends MemoryLocalHistoryAssetAdapter {
      failDeletes = true;

      override async delete(path: string): Promise<void> {
        if (this.failDeletes) throw new Error(`OPFS unavailable: ${path}`);
        await super.delete(path);
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingDeleteAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'cleanup-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });

    const compacted = await history.keepResultsOnly(batch.id);

    expect(compacted.rerunnable).toBe(false);
    expect(compacted.items[0].original).toBeUndefined();
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'keep-results-only',
        unreleasedBytes: 'original-one'.length + 'thumb-one'.length,
        error: expect.stringContaining('OPFS unavailable'),
      }),
    ]);

    assets.failDeletes = false;
    await history.retryCleanup();

    expect(await history.listCleanupFaults()).toEqual([]);
    expect(assets.blobs.size).toBe(0);
  });

  it('resumes only queued or running tasks and preserves every terminal task', async () => {
    const { history } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    await history.appendItems(batch.id, [{
      id: 'image-c',
      file: file('three.png', 'original-three'),
      width: 600,
      height: 900,
      workingCopy: {
        required: false,
        width: 600,
        height: 900,
        scale: 1,
      },
    }]);
    await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['completed-result'], { type: 'image/png' }),
      summary: { detectedRegionCount: 2 },
    });
    await history.updateItem(batch.id, 'image-b', {
      status: 'failed',
      error: 'temporary failure',
    });
    await history.updateItem(batch.id, 'image-c', {
      status: 'running',
    });
    await history.finishBatch(batch.id, 'failed');

    const resumed = await history.resumeBatch(batch.id);

    expect(resumed.id).toBe(batch.id);
    expect(resumed.status).toBe('running');
    expect(resumed.recoveryPoint.nextItemIndex).toBe(2);
    expect(resumed.items[0]).toMatchObject({
      status: 'done',
      summary: { detectedRegionCount: 2 },
      result: { size: 16 },
    });
    expect(resumed.items[1]).toMatchObject({
      status: 'failed',
      error: 'temporary failure',
    });
    expect(resumed.items[2]).toMatchObject({
      status: 'queued',
      result: undefined,
      summary: undefined,
      error: undefined,
    });
  });

  it('persists appended tasks and keeps asset namespaces stable across queued reordering', async () => {
    const { history, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    const appended = await history.appendItems(batch.id, [{
      id: 'image-c',
      file: file('three.png', 'original-three'),
      width: 600,
      height: 900,
      workingCopy: {
        required: false,
        width: 600,
        height: 900,
        scale: 1,
      },
    }]);

    expect(appended.items.map((item) => item.id)).toEqual(['image-a', 'image-b', 'image-c']);
    expect(appended.items[2].original?.path).toBe('batch-1/items/2/original');

    const reordered = await history.reorderQueuedItems(
      batch.id,
      ['image-c', 'image-a', 'image-b'],
    );
    expect(reordered.items.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: 'image-c', order: 0 },
      { id: 'image-a', order: 1 },
      { id: 'image-b', order: 2 },
    ]);

    const completed = await history.updateItem(batch.id, 'image-c', {
      status: 'done',
      result: new Blob(['third-result'], { type: 'image/png' }),
    });
    expect(completed.items[0].result?.path).toMatch(/^batch-1\/items\/2\/result-/u);
    expect(await assets.get('batch-1/items/0/original')).toHaveProperty(
      'size',
      'original-one'.length,
    );

    await expect(
      history.reorderQueuedItems(batch.id, ['image-a', 'image-c', 'image-b']),
    ).rejects.toThrow(/尚未开始/u);
  });

  it('removes only queued tasks after committing the updated index', async () => {
    const { history, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    const removedPath = batch.items[1].original!.path;
    const remaining = await history.removeQueuedItem(batch.id, 'image-b');

    expect(remaining.items.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: 'image-a', order: 0 },
    ]);
    expect(await assets.get(removedPath)).toBeNull();

    await history.updateItem(batch.id, 'image-a', { status: 'running' });
    await expect(history.removeQueuedItem(batch.id, 'image-a')).rejects.toThrow(
      /尚未开始/u,
    );
  });

  it('records retryable cleanup debt when removing a queued task cannot release its assets', async () => {
    class FailingDeleteAssets extends MemoryLocalHistoryAssetAdapter {
      failDeletes = false;

      override async delete(path: string): Promise<void> {
        if (this.failDeletes) throw new Error(`OPFS unavailable: ${path}`);
        await super.delete(path);
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingDeleteAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'remove-cleanup-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    assets.failDeletes = true;

    const remaining = await history.removeQueuedItem(batch.id, 'image-b');

    expect(remaining.items.map((item) => item.id)).toEqual(['image-a']);
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'remove-queued-item',
        unreleasedBytes: 'original-two'.length,
        error: expect.stringContaining('OPFS unavailable'),
      }),
    ]);
  });

  it('refuses to resume when a completed result is missing', async () => {
    const { history, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    const completed = await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['completed-result'], { type: 'image/png' }),
    });
    await assets.delete(completed.items[0].result!.path);

    await expect(history.resumeBatch(batch.id)).rejects.toThrow(/结果缺失或损坏/u);
  });

  it('refuses to resume a results-only batch', async () => {
    const { history } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });
    await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['result'], { type: 'image/png' }),
    });
    await history.keepResultsOnly(batch.id);

    await expect(history.resumeBatch(batch.id)).rejects.toThrow(/只保留结果/u);
  });

  it('records retryable cleanup debt when resume cannot release superseded results', async () => {
    class FailingDeleteAssets extends MemoryLocalHistoryAssetAdapter {
      failDeletes = false;

      override async delete(path: string): Promise<void> {
        if (this.failDeletes) throw new Error(`OPFS unavailable: ${path}`);
        await super.delete(path);
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingDeleteAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'resume-cleanup-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    await history.updateItem(batch.id, 'image-a', {
      status: 'running',
      result: new Blob(['superseded-result'], { type: 'image/png' }),
    });
    await history.finishBatch(batch.id, 'paused');
    assets.failDeletes = true;

    const resumed = await history.resumeBatch(batch.id);

    expect(resumed.items[0]).toMatchObject({
      status: 'queued',
      result: undefined,
    });
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'resume-batch',
        unreleasedBytes: 'superseded-result'.length,
        error: expect.stringContaining('OPFS unavailable'),
      }),
    ]);
  });

  it('commits a replacement result while retaining retryable cleanup debt for the old blob', async () => {
    class FailingDeleteAssets extends MemoryLocalHistoryAssetAdapter {
      failDeletes = false;

      override async delete(path: string): Promise<void> {
        if (this.failDeletes) throw new Error(`OPFS unavailable: ${path}`);
        await super.delete(path);
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingDeleteAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'replace-result-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    const first = await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['old-result'], { type: 'image/png' }),
    });
    assets.failDeletes = true;

    const replaced = await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['new-result'], { type: 'image/png' }),
    });

    expect(replaced.items[0].result?.path).not.toBe(first.items[0].result?.path);
    expect(await assets.get(replaced.items[0].result!.path)).toHaveProperty(
      'size',
      'new-result'.length,
    );
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'replace-result',
        unreleasedBytes: 'old-result'.length,
        error: expect.stringContaining('OPFS unavailable'),
      }),
    ]);
  });

  it('rolls back all visible state when a blob write fails before index commit', async () => {
    class FailingAssets extends MemoryLocalHistoryAssetAdapter {
      override async put(path: string, blob: Blob): Promise<void> {
        if (path.endsWith('/thumbnail')) throw new Error('disk full');
        await super.put(path, blob);
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'failed-batch' },
    );

    await expect(history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    })).rejects.toThrow('disk full');
    expect(await index.list()).toEqual([]);
    expect(assets.blobs.size).toBe(0);
  });

  it('persists staged-write cleanup when index commit and rollback both fail', async () => {
    class FailingIndex extends MemoryLocalHistoryIndexAdapter {
      override async put(): Promise<void> {
        throw new Error('index unavailable');
      }

      override async commit(
        input: Parameters<MemoryLocalHistoryIndexAdapter['commit']>[0],
      ): Promise<void> {
        if (input.putBatch) throw new Error('index unavailable');
        await super.commit(input);
      }
    }
    class FailingRollbackAssets extends MemoryLocalHistoryAssetAdapter {
      override async deleteBatch(): Promise<void> {
        throw new Error('OPFS rollback unavailable');
      }
    }
    const index = new FailingIndex();
    const assets = new FailingRollbackAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'staged-batch' },
    );

    await expect(history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    })).rejects.toThrow('index unavailable');

    expect(await history.list()).toEqual([]);
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: 'staged-batch',
        operation: 'staged-write',
        error: 'OPFS rollback unavailable',
      }),
    ]);
  });

  it('journals appended assets before writing and keeps rollback debt when final index commit fails', async () => {
    class FailingFinalCommitIndex extends MemoryLocalHistoryIndexAdapter {
      failBatchCommit = false;

      override async commit(
        input: Parameters<MemoryLocalHistoryIndexAdapter['commit']>[0],
      ): Promise<void> {
        if (this.failBatchCommit && input.putBatch) throw new Error('index unavailable');
        await super.commit(input);
      }
    }
    class FailingRollbackAssets extends MemoryLocalHistoryAssetAdapter {
      failDeletes = false;

      override async delete(path: string): Promise<void> {
        if (this.failDeletes) throw new Error(`OPFS rollback unavailable: ${path}`);
        await super.delete(path);
      }
    }
    const index = new FailingFinalCommitIndex();
    const assets = new FailingRollbackAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'append-staging-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    index.failBatchCommit = true;
    assets.failDeletes = true;

    await expect(history.appendItems(batch.id, [{
      id: 'image-c',
      file: file('three.png', 'original-three'),
      width: 600,
      height: 900,
      workingCopy: {
        required: false,
        width: 600,
        height: 900,
        scale: 1,
      },
    }])).rejects.toThrow('index unavailable');

    expect((await history.get(batch.id))?.items.map((item) => item.id)).toEqual(['image-a']);
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'staged-write',
        unreleasedBytes: 'original-three'.length,
        error: expect.stringContaining('OPFS rollback unavailable'),
      }),
    ]);
  });

  it('journals a result before writing and preserves the previous result if index commit fails', async () => {
    class FailingFinalCommitIndex extends MemoryLocalHistoryIndexAdapter {
      failBatchCommit = false;

      override async commit(
        input: Parameters<MemoryLocalHistoryIndexAdapter['commit']>[0],
      ): Promise<void> {
        if (this.failBatchCommit && input.putBatch) throw new Error('index unavailable');
        await super.commit(input);
      }
    }
    const index = new FailingFinalCommitIndex();
    const assets = new MemoryLocalHistoryAssetAdapter();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'result-staging-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });
    const first = await history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['first-result'], { type: 'image/png' }),
    });
    index.failBatchCommit = true;

    await expect(history.updateItem(batch.id, 'image-a', {
      status: 'done',
      result: new Blob(['replacement'], { type: 'image/png' }),
    })).rejects.toThrow('index unavailable');

    const stored = await history.get(batch.id);
    expect(stored?.items[0].result).toEqual(first.items[0].result);
    expect(await assets.get(first.items[0].result!.path)).toHaveProperty(
      'size',
      'first-result'.length,
    );
  });

  it('deletes both the batch index and its OPFS asset namespace', async () => {
    const { history, index, assets } = setup();
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems(),
    });

    await history.deleteBatch(batch.id);

    expect(await index.get(batch.id)).toBeNull();
    expect(assets.blobs.size).toBe(0);
  });

  it('keeps a deleted batch hidden when its asset namespace cleanup fails', async () => {
    class FailingBatchDeleteAssets extends MemoryLocalHistoryAssetAdapter {
      override async deleteBatch(): Promise<void> {
        throw new Error('OPFS directory is busy');
      }
    }
    const index = new MemoryLocalHistoryIndexAdapter();
    const assets = new FailingBatchDeleteAssets();
    const history = new LocalHistory(
      index,
      assets,
      new StepClock(),
      { create: () => 'deleted-batch' },
    );
    const batch = await history.createBatch({
      settings: createDefaultWebSettings('zh-CN'),
      versions,
      items: inputItems().slice(0, 1),
    });

    await history.deleteBatch(batch.id);

    expect(await history.get(batch.id)).toBeNull();
    expect(await history.listCleanupFaults()).toEqual([
      expect.objectContaining({
        batchId: batch.id,
        operation: 'delete-batch',
        unreleasedBytes: 'original-one'.length + 'thumb-one'.length,
        error: 'OPFS directory is busy',
      }),
    ]);
  });
});
