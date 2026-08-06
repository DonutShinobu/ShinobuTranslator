import { describe, expect, it } from 'vitest';
import { createBenchmarkModelRuntimeOptions } from '../../apps/extension/src/benchmark/modelRuntime';
import { getExtensionAssetRuntime } from '../../apps/extension/src/shared/extensionRuntime';

describe('benchmark model runtime', () => {
  it('uses origin assets and the HTTP fallback policy outside an extension', () => {
    const options = createBenchmarkModelRuntimeOptions(
      null,
      'http://127.0.0.1:4173/nested/benchmark.html',
    );

    expect(options.workerUrl).toBe('http://127.0.0.1:4173/onnxWorker.js');
    expect(options.ortPath).toBe('http://127.0.0.1:4173/ort/');
    expect(options.workerPolicy).toBe('direct-then-blob');
    expect(options.modelSource.manifestUrl()).toBe(
      'http://127.0.0.1:4173/models/models.json',
    );
  });

  it('ignores Chromium partial extension globals without asset URL support', () => {
    const scope = globalThis as typeof globalThis & { chrome?: unknown };
    const previous = scope.chrome;
    scope.chrome = { runtime: {} };
    try {
      expect(getExtensionAssetRuntime()).toBeNull();
    } finally {
      if (previous === undefined) delete scope.chrome;
      else scope.chrome = previous;
    }
  });

  it('uses extension URLs and the direct-only policy inside an extension', () => {
    const options = createBenchmarkModelRuntimeOptions({
      getURL(path: string) {
        return `chrome-extension://fixture/${path}`;
      },
    }, 'chrome-extension://fixture/benchmark.html');

    expect(options.workerUrl).toBe('chrome-extension://fixture/onnxWorker.js');
    expect(options.ortPath).toBe('chrome-extension://fixture/ort/');
    expect(options.workerPolicy).toBe('direct-only');
    expect(options.modelSource.manifestUrl()).toBe(
      'chrome-extension://fixture/models/models.json',
    );
  });
});
