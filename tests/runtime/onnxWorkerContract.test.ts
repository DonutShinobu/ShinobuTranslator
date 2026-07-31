import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const legacyRpcNames = [
  'runOcrBatchDecode',
  'runOcrSplitBatchDecode',
  'runOcrSingleDecode',
  'runOcrColorBatch',
  'runOcrColorSingle',
];

describe('ONNX Worker production contract', () => {
  it('exposes only the current session, probe, and detector operations', () => {
    const workerTypes = read('src/runtime/onnxWorkerTypes.ts');
    for (const operation of [
      'init(',
      'createSession(',
      'runInference(',
      'probeRuntime(',
      'probePaddleGraphCapture(',
      'runDetectWithGpuPreprocess(',
      'disposeSession(',
      'disposeAll(',
    ]) {
      expect(workerTypes).toContain(operation);
    }
    for (const legacyRpc of legacyRpcNames) {
      expect(workerTypes).not.toContain(legacyRpc);
    }
  });

  it('contains no legacy AR RPC implementation in any production bridge or Worker', () => {
    const productionSources = [
      'src/runtime/onnxBridge.ts',
      'src/runtime/onnxWorkerBridge.ts',
      'src/runtime/onnxNodeBridge.ts',
      'src/workers/onnx-worker.ts',
    ].map(read).join('\n');

    for (const token of [
      ...legacyRpcNames,
      'decodeAutoregressive',
      'gpuArgmax',
      'ocr_encoder',
      'ocr_decoder',
      'fg_ind',
    ]) {
      expect(productionSources).not.toContain(token);
    }
  });

  it('serializes every ONNX Worker inference run through one global queue', () => {
    const worker = read('src/workers/onnx-worker.ts');
    expect(worker).toContain('const inferenceQueue = new SerialInferenceQueue()');
    expect(worker.match(/\.run\(/g)).toHaveLength(3);

    const runInference = worker.slice(
      worker.indexOf('async function runInference('),
      worker.indexOf('// Runtime self-check'),
    );
    const gpuDetect = worker.slice(
      worker.indexOf('async function runDetectWithGpuPreprocess('),
      worker.indexOf('async function probePaddleGraphCapture('),
    );
    const graphCapture = worker.slice(
      worker.indexOf('async function probePaddleGraphCapture('),
      worker.indexOf('// Dispose'),
    );

    for (const queuedRun of [runInference, gpuDetect, graphCapture]) {
      expect(queuedRun).toContain('inferenceQueue.enqueue');
      expect(queuedRun).toMatch(/\.run\(/);
    }
  });

  it('closes transferred detector images when their session was lost', () => {
    const worker = read('src/workers/onnx-worker.ts');
    const detector = worker.slice(
      worker.indexOf('async function runDetectWithGpuPreprocess('),
      worker.indexOf('async function probePaddleGraphCapture('),
    );
    const missingSession = detector.slice(
      detector.indexOf('if (!entry)'),
      detector.indexOf('if (entry.provider'),
    );

    expect(missingSession).toContain('imageSource.close()');
    expect(missingSession.indexOf('imageSource.close()'))
      .toBeLessThan(missingSession.indexOf("code: 'session-lost'"));
  });

  it('removes executable legacy modules while preserving history and conversion references', () => {
    for (const removedPath of [
      'src/pipeline/ocr/decodeAutoregressive.ts',
      'src/pipeline/ocr/gpuArgmax.ts',
      'src/pipeline/ocr/color.ts',
      'src/pipeline/ocr/colorDecodeShared.ts',
      'benchmark/perf/src/run-ocr-gpu-argmax.ts',
      'benchmark/perf/src/run-browser-x-compare.ts',
    ]) {
      expect(existsSync(resolve(root, removedPath))).toBe(false);
    }
    for (const preservedPath of [
      'benchmark/perf/ocr-cold-start-experiments-2026-06-13.md',
      'benchmark/perf/reports/perf-baseline-2026-05-28T12-51-45-241Z.json',
      'benchmark/perf/reports/x-compare-2026-06-01T07-40-51-808Z.json',
      'scripts/legacy/README.md',
      'scripts/legacy/export_ocr_ar_to_onnx.py',
      'scripts/legacy/split-ocr-encoder-decoder.mjs',
      'scripts/legacy/patch_lama_webgpu.py',
    ]) {
      expect(existsSync(resolve(root, preservedPath))).toBe(true);
    }
  });

  it('keeps only current benchmark commands and the current model manifest', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['bench:ocr-gpu-argmax']).toBeUndefined();
    expect(packageJson.scripts['bench:browser-x-compare']).toBeUndefined();
    expect(packageJson.scripts['bench:browser-x-current']).toBeUndefined();
    expect(packageJson.scripts['models:split-ocr']).toBeUndefined();
    expect(packageJson.scripts['bench:browser-paddle-profile']).toContain('run-browser-paddle-profile.ts');
    expect(packageJson.scripts['bench:browser-pipeline-batch']).toContain(
      'run-browser-pipeline-batch.ts',
    );

    const manifest = JSON.parse(read('public/models/models.json')) as { models: Record<string, unknown> };
    expect(Object.keys(manifest.models).sort()).toEqual([
      'bubble',
      'detector',
      'inpaint',
      'paddleocr_v6_medium_rec',
    ]);

    const releaseGuard = read(
      'apps/extension/scripts/check-release-boundaries.mjs',
    );
    for (const legacyModel of [
      'ocr.onnx',
      'ocr_encoder.onnx',
      'ocr_decoder.onnx',
      'PP-OCRv6_small_rec.onnx',
      'lama_fp32.onnx',
    ]) {
      expect(releaseGuard).toContain(legacyModel);
    }
  });
});
