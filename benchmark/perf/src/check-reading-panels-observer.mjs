import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/readingOrder.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source.replace(/^import[^\r\n]*\r?\n/gm, '').replace(/^export\s+/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
});
assert.deepEqual(transpiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
const flags = { __shinobuColdStartPixelFastPath: true };
let clockReads = 0;
const warnings = [];
const prepare = new Function('globalThis', 'performance', 'console', 'clamp',
  transpiled.outputText + '\nreturn prepareReadingPanels;')(
  flags, { now: () => ++clockReads }, { warn: text => warnings.push(text) },
  (value, min, max) => Math.max(min, Math.min(max, value)),
);

// Same two-panel pixel fixture as readingOrder.prepared.test.ts.
const width = 300, height = 400;
const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
for (let y = 10; y < 390; y++) {
  if (y >= 185 && y < 215) continue;
  for (let x = 10; x < 290; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
  }
}
const before = pixels.slice(), canvas = { width, height };
let failRead = false;
const platform = { createCanvas: (w, h) => {
  assert.equal(w, width); assert.equal(h, height);
  return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData() {
    if (failRead) throw new Error('canvas read failed');
    return { width, height, data: pixels.slice() };
  } }) };
} };

const baseline = prepare(canvas, platform);
assert.equal(baseline.length, 2);
assert.equal(clockReads, 0, 'default path must not read the clock');
flags.__shinobuColdStartInitMark = true;
assert.deepEqual(prepare(canvas, platform), baseline);
assert.equal(clockReads, 0, 'non-function observer must not enable timing');

const records = [];
flags.__shinobuColdStartInitMark = record => records.push(record);
assert.deepEqual(prepare(canvas, platform), baseline);
assert.equal(records.length, 1, 'one aggregate per successful preparation');
const record = records[0];
assert.equal(record.phase, 'reading-panels.prepare');
assert.equal(record.panelCount, 2);
assert.deepEqual([record.sourceWidth, record.sourceHeight, record.scaledWidth, record.scaledHeight], [width, height, width, height]);
for (const field of ['canvasSetupMs', 'canvasDrawResizeMs', 'canvasReadMs', 'grayMs', 'gaussianMs',
  'thresholdMs', 'borderInvertMs', 'componentsMs', 'rectFilterMs']) assert.equal(record[field], 1, field);
assert.equal(record.durationMs, 10);
let throwingCalls = 0;
flags.__shinobuColdStartInitMark = () => { throwingCalls++; throw new Error('observer failed'); };
assert.deepEqual(prepare(canvas, platform), baseline);
assert.equal(throwingCalls, 1);
assert.equal(warnings.length, 0, 'observer failure must not trigger panel fallback');
failRead = true;
assert.equal(prepare(canvas, platform), null, 'original canvas failure fallback remains');
assert.equal(warnings.length, 1);
assert.deepEqual(pixels, before);
console.log('reading-panels observer: syntax, zero default clocks, one aggregate, unchanged panels/input, observer error and original failure fallback passed');
