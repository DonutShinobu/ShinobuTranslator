import assert from 'node:assert/strict';
import { tryNativeOpaqueMaskThreshold } from '../../../packages/image-pipeline/src/pipeline/image';
import type { PipelineCanvas, PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';

// Tiny branch/API oracle. Native filter/Canvas pixels are checked by Root's
// browser gate; this verifies strict flags, unchanged calls, and failure cleanup.
type Attrs = { colorSpace: string; colorType: string; willReadFrequently?: boolean };
type Settings = { colorSpace?: string; colorType?: string; willReadFrequently?: boolean };
type Mode = 'ok' | 'unknown-attrs' | 'p3' | 'float16' | 'no-context' | 'no-filter' | 'reject-filter' | 'draw-throws' | 'attrs-throws';
type FakeCanvas = {
  width: number; height: number; data: Uint8ClampedArray; disposed: number;
  settings?: Settings; draws: number; saved: number; restored: number;
  ctx: {
    filter: string | undefined; imageSmoothingEnabled: boolean; globalCompositeOperation: string;
    getContextAttributes: () => Attrs | undefined; save: () => void; restore: () => void;
    drawImage: (source: FakeCanvas, x: number, y: number) => void;
  };
  getContext: (kind: string, settings?: Settings) => FakeCanvas['ctx'] | null;
  dispose: () => void;
};
function canvas(data: Uint8ClampedArray, mode: Mode = 'ok', source = false): FakeCanvas {
  const c = { width: data.length / 4, height: 1, data: data.slice(), disposed: 0, draws: 0, saved: 0, restored: 0 } as FakeCanvas;
  let filter: string | undefined = mode === 'no-filter' ? undefined : 'none';
  let saved: [string | undefined, boolean, string] | undefined;
  c.ctx = {
    get filter() { return filter; },
    set filter(value) { if (mode !== 'reject-filter' || value !== 'contrast(100000%)') filter = value; },
    imageSmoothingEnabled: true, globalCompositeOperation: 'source-over',
    getContextAttributes: () => {
      if (mode === 'attrs-throws') throw Error('Synthetic attribute failure');
      if (mode === 'unknown-attrs') return undefined;
      return { colorSpace: mode === 'p3' ? 'display-p3' : 'srgb', colorType: mode === 'float16' ? 'float16' : 'unorm8', willReadFrequently: c.settings?.willReadFrequently };
    },
    save: () => { c.saved++; saved = [filter, c.ctx.imageSmoothingEnabled, c.ctx.globalCompositeOperation]; },
    restore: () => { c.restored++; if (saved) [filter, c.ctx.imageSmoothingEnabled, c.ctx.globalCompositeOperation] = saved; },
    drawImage: (src, x, y) => {
      assert.equal(x, 0); assert.equal(y, 0); assert.equal(c.ctx.filter, 'contrast(100000%)');
      assert.equal(c.ctx.imageSmoothingEnabled, false); assert.equal(c.ctx.globalCompositeOperation, 'copy');
      c.draws++;
      if (mode === 'draw-throws') throw Error('Synthetic native drawing failure');
      for (let p = 0; p < src.data.length; p += 4) {
        const v = src.data[p] > 127 ? 255 : 0;
        c.data[p] = c.data[p + 1] = c.data[p + 2] = v; c.data[p + 3] = src.data[p + 3];
      }
    },
  };
  c.getContext = (kind, settings) => {
    assert.equal(kind, '2d');
    if (!source && !c.settings) c.settings = settings;
    if (mode === 'no-context') return null;
    return c.ctx;
  };
  c.dispose = () => { c.disposed++; };
  return c;
}
const bytes = new Uint8ClampedArray(256 * 4);
for (let v = 0; v < 256; v++) { bytes[v * 4] = bytes[v * 4 + 1] = bytes[v * 4 + 2] = v; bytes[v * 4 + 3] = 255; }
const expected = bytes.map((value, i) => i % 4 === 3 ? 255 : value > 127 ? 255 : 0);
const flags = globalThis as typeof globalThis & {
  __shinobuColdStartMaskNativeThreshold?: unknown;
  __shinobuColdStartMaskNativeThresholdGpu?: unknown;
  __shinobuColdStartInitMark?: unknown;
};
const keys = ['__shinobuColdStartMaskNativeThreshold', '__shinobuColdStartMaskNativeThresholdGpu', '__shinobuColdStartInitMark'] as const;
const savedFlags = keys.map(key => ({ key, present: Object.hasOwn(flags, key), value: flags[key] }));
let checks = 0;
function run(main: unknown, gpu: unknown, sourceMode: Mode = 'ok', targetMode: Mode = 'ok', observerThrows = false): void {
  flags.__shinobuColdStartMaskNativeThreshold = main; flags.__shinobuColdStartMaskNativeThresholdGpu = gpu;
  const records: Record<string, unknown>[] = [];
  flags.__shinobuColdStartInitMark = (record: Record<string, unknown>) => { records.push(record); if (observerThrows) throw Error('Optional observer failure'); };
  const src = canvas(bytes, sourceMode, true), targets: FakeCanvas[] = [];
  const platform = { createCanvas: (width: number, height: number) => {
    assert.equal(width, src.width); assert.equal(height, src.height);
    const target = canvas(new Uint8ClampedArray(width * height * 4), targetMode); targets.push(target); return target;
  } } as unknown as PlatformProvider;
  const result = tryNativeOpaqueMaskThreshold(src as unknown as PipelineCanvas, platform) as unknown as FakeCanvas | null;
  assert.deepEqual(src.data, bytes, 'Source pixels unchanged'); assert.equal(src.draws, 0); assert.equal(src.disposed, 0);
  if (main !== true) {
    assert.equal(result, null); assert.equal(targets.length, 0); assert.equal(records.length, 0);
  } else if (sourceMode === 'ok' && targetMode === 'ok') {
    assert.equal(result, targets[0]); assert.deepEqual(result!.data, expected);
    assert.deepEqual(result!.settings, { willReadFrequently: gpu !== true, colorSpace: 'srgb', colorType: 'unorm8' });
    assert.equal(result!.draws, 1); assert.equal(result!.saved, 1); assert.equal(result!.restored, 1);
    assert.equal(result!.ctx.filter, 'none'); assert.equal(result!.ctx.imageSmoothingEnabled, true);
    assert.equal(result!.ctx.globalCompositeOperation, 'source-over'); assert.equal(result!.disposed, 0);
    assert.equal(records.length, 1); assert.equal(records[0].status, 'success');
  } else {
    assert.equal(result, null, 'Unsupported/error must retain caller CPU fallback'); assert.equal(records.length, 1);
    assert.notEqual(records[0].status, 'success');
    for (const target of targets) {
      assert.equal(target.disposed, 1); assert.equal(target.width, 0); assert.equal(target.height, 0);
      assert.deepEqual(target.settings, { willReadFrequently: gpu !== true, colorSpace: 'srgb', colorType: 'unorm8' });
      assert.equal(target.saved, target.restored);
    }
  }
  checks++;
}
try {
  for (const main of [undefined, false, true, 'true', 1, null]) for (const gpu of [undefined, false, true, 'true', 1, null]) run(main, gpu);
  for (const gpu of [false, true]) {
    run(true, gpu, 'ok', 'ok', true);
    for (const mode of ['unknown-attrs', 'p3', 'float16', 'no-context', 'attrs-throws'] as Mode[]) run(true, gpu, mode);
    for (const mode of ['unknown-attrs', 'p3', 'float16', 'no-context', 'no-filter', 'reject-filter', 'draw-throws', 'attrs-throws'] as Mode[]) run(true, gpu, 'ok', mode);
  }
  console.log(JSON.stringify({ checks, result: 'passed', strictFlags: true, unchangedOpaqueSource: true, fallbackAndCleanup: true, nativeFilterQuality: 'Root browser gate required' }));
} finally {
  for (const { key, present, value } of savedFlags) { if (present) flags[key] = value; else delete flags[key]; }
}
