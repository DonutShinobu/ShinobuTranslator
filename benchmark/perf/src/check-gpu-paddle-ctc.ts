import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from '@playwright/test';
import { decodePaddleCtc } from '../../../packages/image-pipeline/src/pipeline/ocr/paddleocrDecode';

const root = resolve(import.meta.dirname, '../../..');
const bundle = await build({
  configFile: false, logLevel: 'silent',
  build: { write: false, lib: {
    entry: resolve(root, 'packages/model-runtime/src/workers/gpuPaddleCtc.ts'),
    formats: ['iife'], name: 'GpuCtc',
  } },
});
const built = Array.isArray(bundle) ? bundle[0] : bundle;
if (!('output' in built)) throw new Error('Unexpected bundle');
const code = built.output.find(item => item.type === 'chunk');
if (!code || code.type !== 'chunk') throw new Error('Missing check bundle');
const server = createServer((_req, res) => res.end('<!doctype html><title>GPU CTC check</title>'));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing check server');
const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.addScriptTag({ content: code.code });
  const dims = [2, 11, 18710];
  const classes = dims[2];
  const logits = new Float32Array(dims[0] * dims[1] * classes);
  for (let i = 0; i < logits.length; i++) logits[i] = ((Math.imul(i + 17, 48271) >>> 0) % 100000) / 100000;
  const row = (index: number) => logits.subarray(index * classes, (index + 1) * classes);
  row(1).fill(0);
  row(2).fill(-Infinity);
  row(3)[0] = NaN;
  row(4)[3] = NaN;
  row(5)[127] = row(5)[128] = 2;
  row(6)[1] = row(6)[18709] = Infinity;
  row(7).fill(NaN); row(7)[0] = 0;
  row(8).fill(-1); row(8)[0] = -0; row(8)[1] = 0;
  const packed = await page.evaluate(async ({ data, dims }) => {
    const api = (globalThis as unknown as { GpuCtc: {
      reducePaddleCtc(device: GPUDevice, source: GPUBuffer, dims: number[]): Promise<{ data: Float32Array }>;
    } }).GpuCtc;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const input = new Float32Array(data);
    const source = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(source, 0, input);
      const result = await api.reducePaddleCtc(device, source, dims);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      return Array.from(result.data);
    } finally { source.destroy(); device.destroy(); }
  }, { data: Array.from(logits), dims });
  for (let t = 0; t < packed.length / 2; t++) {
    const values = row(t);
    let index = 0;
    for (let c = 1; c < classes; c++) if (values[c] > values[index]) index = c;
    assert.equal(packed[t * 2], index, `class at row ${t}`);
    assert.equal(packed[t * 2 + 1], values[index], `probability at row ${t}`);
  }
  const charset = Array.from({ length: classes }, (_, i) => String(i));
  for (let batch = 0; batch < dims[0]; batch++) {
    assert.deepEqual(
      decodePaddleCtc(new Float32Array(packed.slice(batch * dims[1] * 2, (batch + 1) * dims[1] * 2)), dims[1], 2, charset, true),
      decodePaddleCtc(logits.subarray(batch * dims[1] * classes, (batch + 1) * dims[1] * classes), dims[1], classes, charset),
    );
  }
  console.log('GPU CTC exact float32 maxima + CTC check passed (ties, NaN, Infinity, signed zero, multi-batch).');
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
