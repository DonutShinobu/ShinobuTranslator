import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import {
  LocalHistory,
  MemoryLocalHistoryAssetAdapter,
  MemoryLocalHistoryIndexAdapter,
  type LocalHistoryClock,
} from '../../apps/web/src/features/history/localHistory';
import {
  buildProjectPackage,
  buildResultsZip,
  validateProjectPackage,
} from '../../apps/web/src/features/history/projectPackage';

class FixedClock implements LocalHistoryClock {
  now(): Date {
    return new Date('2026-07-28T00:00:00.000Z');
  }
}

function setup(ids = ['source-batch']) {
  let index = 0;
  const historyIndex = new MemoryLocalHistoryIndexAdapter();
  const assets = new MemoryLocalHistoryAssetAdapter();
  const history = new LocalHistory(
    historyIndex,
    assets,
    new FixedClock(),
    { create: () => ids[index++] },
  );
  return { history, historyIndex, assets };
}

async function sourceBatch() {
  const state = setup(['source-batch', 'imported-batch']);
  const batch = await state.history.createBatch({
    settings: createDefaultWebSettings('zh-CN'),
    versions: {
      app: '0.1.0',
      core: '0.8.1',
      model: 'model-v1',
      configSchema: 1,
    },
    items: [{
      id: 'image-1',
      file: new File(['original'], 'page-01.png', { type: 'image/png' }),
      thumbnail: new Blob(['thumbnail'], { type: 'image/webp' }),
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
  await state.history.updateItem(batch.id, 'image-1', {
    status: 'done',
    result: new Blob(['translated'], { type: 'image/png' }),
    summary: {
      schemaVersion: 1,
      image: { width: 1200, height: 1800 },
      ocr: [{
        id: 'region-1',
        order: 0,
        box: { x: 10, y: 20, width: 100, height: 80 },
        direction: 'v',
        confidence: 0.98,
        text: 'こんにちは',
      }],
      translations: [{
        id: 'region-1',
        order: 0,
        box: { x: 10, y: 20, width: 100, height: 80 },
        direction: 'v',
        sourceText: 'こんにちは',
        translatedText: '你好',
        translatedColumns: ['你好'],
      }],
    },
  });
  await state.history.finishBatch(batch.id, 'completed');
  return {
    ...state,
    inspection: (await state.history.inspect(batch.id))!,
  };
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function zipBlob(files: Record<string, Uint8Array>): Blob {
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

describe('project packages', () => {
  it('exports a versioned manifest, validates hashes, and imports under a new local batch ID', async () => {
    const { history, inspection } = await sourceBatch();
    const project = await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
      '2026-07-28T01:00:00.000Z',
    );
    const validated = await validateProjectPackage(project);

    expect(validated.manifest).toMatchObject({
      format: 'shinobu-project',
      schemaVersion: 1,
      exportedAt: '2026-07-28T01:00:00.000Z',
      batch: { id: 'source-batch', status: 'completed' },
    });
    expect(validated.manifest.files).toHaveLength(3);
    expect(JSON.stringify(validated.manifest)).not.toMatch(/api[-_]?key/iu);
    expect(validated.manifest.batch.items[0].summary).toMatchObject({
      schemaVersion: 1,
      ocr: [{ text: 'こんにちは' }],
      translations: [{ translatedText: '你好' }],
    });

    const imported = await history.importBatch(
      validated.manifest.batch,
      validated.assets,
    );
    expect(imported.id).toBe('imported-batch');
    expect(imported.items[0]).toMatchObject({
      status: 'done',
      original: { fileName: 'page-01.png' },
      result: { fileName: 'page-01.png' },
    });
    expect(imported.items[0].original?.path).toMatch(/^imported-batch\//u);
    expect((await history.inspect(imported.id))?.integrity).toBe('complete');
  });

  it('exports a result-only ZIP with deterministic ordered PNG names', async () => {
    const { history, inspection } = await sourceBatch();

    const resultZip = await buildResultsZip(
      inspection,
      (reference) => history.readAsset(reference),
    );
    const files = unzipSync(await bytes(resultZip));

    expect(Object.keys(files)).toEqual(['001-page-01.png']);
    expect(new TextDecoder().decode(files['001-page-01.png'])).toBe('translated');
  });

  it('rejects traversal paths, HTML, undeclared files, and duplicate manifest declarations', async () => {
    const { history, inspection } = await sourceBatch();
    const valid = unzipSync(await bytes(await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
    )));

    expect(() => validateProjectPackage(zipBlob({
      ...valid,
      '../escape.png': new Uint8Array([1]),
    }))).rejects.toThrow(/不允许的路径/u);
    expect(() => validateProjectPackage(zipBlob({
      ...valid,
      'assets/0/payload.html': new Uint8Array([1]),
    }))).rejects.toThrow(/不允许的路径/u);
    expect(() => validateProjectPackage(zipBlob({
      ...valid,
      'assets/99/result.png': new Uint8Array([1]),
    }))).rejects.toThrow(/未声明文件/u);

    const manifest = JSON.parse(new TextDecoder().decode(valid['manifest.json']));
    manifest.files.push(manifest.files[0]);
    expect(() => validateProjectPackage(zipBlob({
      ...valid,
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    }))).rejects.toThrow(/重复路径/u);
  });

  it('rejects tampered assets, forbidden credential fields, and newer schemas before import', async () => {
    const { history, inspection } = await sourceBatch();
    const valid = unzipSync(await bytes(await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
    )));
    const assetPath = Object.keys(valid).find((path) => path.endsWith('/result.png'))!;
    valid[assetPath][0] ^= 0xff;
    await expect(validateProjectPackage(zipBlob(valid))).rejects.toThrow(/SHA-256/u);

    const fresh = unzipSync(await bytes(await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
    )));
    const manifest = JSON.parse(new TextDecoder().decode(fresh['manifest.json']));
    manifest.apiKey = 'must-not-import';
    await expect(validateProjectPackage(zipBlob({
      ...fresh,
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    }))).rejects.toThrow(/禁止的凭据字段/u);

    delete manifest.apiKey;
    manifest.schemaVersion = 999;
    await expect(validateProjectPackage(zipBlob({
      ...fresh,
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    }))).rejects.toThrow(/版本过新/u);
  });

  it('excludes legacy diagnostic summaries and rejects malformed OCR records', async () => {
    const { history, inspection } = await sourceBatch();
    inspection.batch.items[0].summary = {
      translationDebug: { llmBatchRawResponse: 'sensitive response' },
      typesetDebug: { regions: [{ sourceText: 'sensitive OCR' }] },
    };
    const files = unzipSync(await bytes(await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
    )));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));

    expect(manifest.batch.items[0].summary).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('sensitive response');
    manifest.batch.items[0].summary = {
      schemaVersion: 1,
      image: { width: 1200, height: 1800 },
      ocr: [{ id: 'region-1', order: 7, box: { x: 0, y: 0, width: 1, height: 1 }, text: 'x' }],
      translations: [],
    };
    await expect(validateProjectPackage(zipBlob({
      ...files,
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    }))).rejects.toThrow(/OCR 或译文记录/u);
  });

  it('rolls back imported assets if the final index commit fails', async () => {
    const { history, inspection } = await sourceBatch();
    const validated = await validateProjectPackage(await buildProjectPackage(
      inspection,
      (reference) => history.readAsset(reference),
    ));
    class FailingIndex extends MemoryLocalHistoryIndexAdapter {
      override async put(): Promise<void> {
        throw new Error('index unavailable');
      }
    }
    const assets = new MemoryLocalHistoryAssetAdapter();
    const importing = new LocalHistory(
      new FailingIndex(),
      assets,
      new FixedClock(),
      { create: () => 'failed-import' },
    );

    await expect(importing.importBatch(
      validated.manifest.batch,
      validated.assets,
    )).rejects.toThrow('index unavailable');
    expect(assets.blobs.size).toBe(0);
  });
});
