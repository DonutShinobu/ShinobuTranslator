import assert from 'node:assert/strict';
import { refineTextMask } from '../../../packages/image-pipeline/src/pipeline/maskRefinement';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import type {
  PipelineCanvas, PipelineImageData, PipelineRenderingContext, PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';

// Tiny array Canvas verifies diagnostic behavior, not browser interpolation.
class ArrayCanvas implements PipelineCanvas {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext(): PipelineRenderingContext {
    const canvas = this;
    return {
      drawImage(source: ArrayCanvas, _x: number, _y: number, width = source.width, height = source.height) {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const sourceOffset = (Math.min(source.height - 1, Math.floor(y * source.height / height)) * source.width
            + Math.min(source.width - 1, Math.floor(x * source.width / width))) * 4;
          canvas.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), (y * canvas.width + x) * 4);
        }
      },
      createImageData(width: number, height: number): PipelineImageData {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      getImageData(): PipelineImageData {
        return { width: canvas.width, height: canvas.height, data: canvas.data.slice() };
      },
      putImageData(image: PipelineImageData) { canvas.data = image.data.slice(); },
    } as unknown as PipelineRenderingContext;
  }
  toDataURL(): string { throw new Error('Encoding is not part of this check'); }
}
const platform = { createCanvas: (width: number, height: number) => new ArrayCanvas(width, height) } as unknown as PlatformProvider;
const source = new ArrayCanvas(44, 36), rawMask = new ArrayCanvas(44, 36);
const regions: TextRegion[] = [
  { id: 'left', box: { x: 3, y: 4, width: 18, height: 24 }, fontSize: 12, sourceText: 'A', translatedText: '甲' },
  { id: 'right', box: { x: 23, y: 9, width: 18, height: 25 }, fontSize: 12, sourceText: 'B', translatedText: '乙' },
];
for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
  const isText = (x >= 7 && x <= 15 && y >= 10 && y <= 17)
    || (x >= 27 && x <= 35 && y >= 16 && y <= 23);
  source.data.set([isText ? 10 : 230, isText ? 10 : 230, isText ? 10 : 230, 255], (y * source.width + x) * 4);
  rawMask.data.set([isText ? 255 : 0, isText ? 255 : 0, isText ? 255 : 0, 255], (y * source.width + x) * 4);
}
const originalSource = source.data.slice(), originalMask = rawMask.data.slice(), originalRegions = structuredClone(regions);
const root = globalThis as {
  __shinobuColdStartMaskProfile?: boolean;
  __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
};
const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
let nowCalls = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => ++nowCalls });
const run = (debug: boolean) => {
  const result = refineTextMask(source, regions, rawMask, platform, {}, debug);
  return { rgba: (result.refinedMaskCanvas as ArrayCanvas).data, debug: result.debugLayers };
};
try {
  for (const debug of [false, true]) {
    const records: Record<string, unknown>[] = [];
    root.__shinobuColdStartMaskProfile = false;
    root.__shinobuColdStartInitMark = record => records.push(record);
    const before = nowCalls, reference = run(debug);
    assert.equal(records.length, 0); assert.equal(nowCalls, before);

    root.__shinobuColdStartMaskProfile = true;
    delete root.__shinobuColdStartInitMark;
    const unobservedBefore = nowCalls;
    assert.deepEqual(run(debug), reference); assert.equal(nowCalls, unobservedBefore);

    root.__shinobuColdStartInitMark = record => records.push(record);
    assert.deepEqual(run(debug), reference); assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.phase, 'mask.refinement'); assert.equal(record.regionCount, 2);
    assert.equal(record.processedRegionCount, 2); assert.equal(record.componentCount, 2);
    assert.equal(record.width, 44); assert.equal(record.height, 36);
    assert.equal(record.scaledWidth, 29); assert.equal(record.scaledHeight, 24);
    assert.equal(record.collectDebugLayers, debug);
    const timings = record.timings as Record<string, number>;
    const outerStages = ['readBinaryMs', 'readGrayMs', 'prepareCcMs', 'ccMs', 'assignmentMs',
      'regionsMs', 'finalDilateMs', 'toMaskCanvasMs'];
    for (const key of [...outerStages, 'refineMs', 'outlineMs', 'localDilateMs']) assert.ok(timings[key] > 0, key);
    assert.ok(outerStages.reduce((sum, key) => sum + timings[key], 0) <= (record.durationMs as number));
    assert.ok(timings.refineMs + timings.outlineMs + timings.localDilateMs <= timings.regionsMs);
    assert.ok(Object.values(record).every(value => value === timings || value === null
      || ['string', 'number', 'boolean'].includes(typeof value)), 'Record contains only scalar metadata and timing scalars');

    let throwingCalls = 0;
    root.__shinobuColdStartInitMark = () => { throwingCalls++; throw new Error('Diagnostic observer failure'); };
    assert.deepEqual(run(debug), reference); assert.equal(throwingCalls, 1);
    assert.deepEqual(source.data, originalSource); assert.deepEqual(rawMask.data, originalMask);
    assert.deepEqual(regions, originalRegions);
  }
  console.log(JSON.stringify({ result: 'mask-profile-identical-output-debug-inputs-unchanged-observer-error-isolated',
    cases: 8, canvasPixels: source.width * source.height,
    noObserverClockCalls: 0, disabledClockCalls: 0, callbacksPerObservedMask: 1,
    caveat: 'Tiny CPU array Canvas only; real browser interpolation/hash and timing are separate' }));
} finally {
  delete root.__shinobuColdStartMaskProfile; delete root.__shinobuColdStartInitMark;
  if (originalNow) Object.defineProperty(performance, 'now', originalNow);
  else Reflect.deleteProperty(performance, 'now');
}
