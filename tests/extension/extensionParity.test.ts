import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createExtensionManifest } from '../../apps/extension/manifest';
import {
  chromiumColdStartBanner, chromiumColdStartFlags,
  firefoxColdStartBanner, firefoxColdStartFlags,
} from '../../scripts/cold-start-defaults.mjs';

it('requires each browser preset while strictly checking shared Worker and resource bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shinobu-parity-'));
  const chromium = join(directory, 'chromium'), firefox = join(directory, 'firefox');
  const prefixes = { chromium: `${chromiumColdStartBanner}\n`, firefox: `${firefoxColdStartBanner}\n` };
  const body = 'globalThis.shared = 1;\n';
  const run = () => spawnSync(process.execPath, [
    resolve('scripts/check-extension-parity.mjs'), '--chromium', chromium, '--firefox', firefox,
  ], { encoding: 'utf8' });
  const fail = (message: string) => {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  };
  try {
    for (const [target, dist] of [['chromium', chromium], ['firefox', firefox]] as const) {
      mkdirSync(join(dist, 'chunks'), { recursive: true });
      writeFileSync(join(dist, 'manifest.json'), JSON.stringify(createExtensionManifest(target, '0.8.3')));
      writeFileSync(join(dist, 'chunks/shared.js'), prefixes[target] + body);
      writeFileSync(join(dist, 'onnxWorker.js'), prefixes[target] + body);
      for (const resource of ['models', 'ort', 'fonts']) {
        mkdirSync(join(dist, resource));
        writeFileSync(join(dist, resource, 'shared.bin'), 'shared resource');
      }
    }
    expect(run().status).toBe(0);
    for (const [target, dist] of [['chromium', chromium], ['firefox', firefox]] as const) {
      const label = target === 'chromium' ? 'Chromium' : 'Firefox';
      const other = target === 'chromium' ? 'firefox' : 'chromium';
      const prefix = prefixes[target];
      const shared = join(dist, 'chunks/shared.js');
      for (const [code, error] of [
        [prefix + body.replace('1', '2'), 'Shared artifact SHA-256 mismatch'],
        [body, `Missing canonical ${label} preset`],
        [prefixes[other] + body, `Missing canonical ${label} preset`],
        [prefix + prefixes.chromium + body, 'Duplicate Chromium preset'],
        [prefix + prefixes.firefox + body, 'Duplicate Firefox preset'],
        [prefix.replace('=true;', '=false;') + body, `Missing canonical ${label} preset`],
      ]) {
        writeFileSync(shared, code);
        fail(error);
      }
      writeFileSync(shared, prefix + body);
      const worker = join(dist, 'onnxWorker.js');
      writeFileSync(worker, prefix + body.replace('1', '2'));
      fail('Shared artifact SHA-256 mismatch: onnxWorker.js');
      writeFileSync(worker, prefix + body);
    }
    const shared = join(chromium, 'chunks/shared.js');
    rmSync(shared);
    fail('Non-adapter artifact exists in only one target');
    writeFileSync(shared, prefixes.chromium + body);
    for (const resource of ['models', 'ort', 'fonts']) {
      const path = join(chromium, resource, 'shared.bin');
      writeFileSync(path, 'changed resource');
      fail('Shared artifact SHA-256 mismatch');
      writeFileSync(path, 'shared resource');
    }
    for (const dist of [chromium, firefox]) {
      const worker = join(dist, 'onnxWorker.js'), saved = readFileSync(worker);
      rmSync(worker);
      fail('Both extension targets require onnxWorker.js');
      writeFileSync(worker, saved);
    }
    expect(run().status).toBe(0);
  } finally {
    // mkdtemp owns this exact directory under the named test prefix.
    if (!directory.startsWith(join(tmpdir(), 'shinobu-parity-'))) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('keeps Firefox GPU optimizations while excluding the five unsupported defaults', () => {
  expect(chromiumColdStartFlags).toHaveLength(27);
  expect(firefoxColdStartFlags).toHaveLength(22);
  for (const name of [
    'StructuredClone', 'MaskNativeThreshold', 'MaskNativeThresholdGpu',
    'ShaderTemplates', 'ReuseShaderPipelines',
  ]) {
    expect(firefoxColdStartFlags).not.toContain(`__shinobuColdStart${name}`);
  }
  for (const name of ['GpuCtc', 'GpuPreprocessNoFence', 'DetectorReadbackParallel', 'ReuseGpuAvailability']) {
    expect(firefoxColdStartFlags).toContain(`__shinobuColdStart${name}`);
  }
});
