import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { detectOutlineWidth } from '../../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms';
import type { Rect } from '../../../packages/image-pipeline/src/types';

// Inspect the private selector without adding a public pipeline API. Full
// detectOutlineWidth is exercised through the real exported implementation.
const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('algorithms.ts', source, ts.ScriptTarget.ES2022, true);
const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'outsideGrayQuarterHistogram');
if (!node) throw new Error('Histogram selector source missing');
const quarterHistogram = new Function(ts.transpileModule(node.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn outsideGrayQuarterHistogram;')() as (
  gray: Uint8Array, mask: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number,
) => number | undefined;

function quarterSort(gray: Uint8Array, mask: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number): number | undefined {
  const outside: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * width + x] === 0) outside.push(gray[y * width + x]);
  outside.sort((a, b) => a - b);
  return outside[Math.floor(outside.length * 0.25)];
}
let selectorsChecked = 0, completeFunctionsChecked = 0;
const flags = globalThis as { __shinobuColdStartMaskHistogram?: boolean };
let randomState = 0x53bf6d79;
function random(): number {
  randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
  return randomState >>> 0;
}
function checkQuarter(gray: Uint8Array, mask: Uint8Array, width: number, height: number): void {
  assert.equal(quarterHistogram(gray, mask, width, 0, 0, width - 1, height - 1),
    quarterSort(gray, mask, width, 0, 0, width - 1, height - 1));
  selectorsChecked++;
}
function compareComplete(gray: Uint8Array, mask: Uint8Array, width: number, height: number, rect: Rect, textSize: number): number {
  const originalGray = gray.slice(), originalMask = mask.slice();
  flags.__shinobuColdStartMaskHistogram = false;
  const reference = detectOutlineWidth(gray, mask, width, height, rect, textSize);
  flags.__shinobuColdStartMaskHistogram = true;
  assert.equal(detectOutlineWidth(gray, mask, width, height, rect, textSize), reference);
  assert.deepEqual(gray, originalGray); assert.deepEqual(mask, originalMask);
  completeFunctionsChecked++;
  return reference;
}
try {
  // Empty, endpoints, fractional-rank boundaries, ties, and all 256 byte values.
  for (const values of [[], [0], [255], [1, 2], [2, 1, 0], [0, 0, 255, 255], [1, 2, 3, 4, 5],
    [0, 0, 0, 1, 1, 1, 255, 255], Array.from({ length: 256 }, (_, i) => i * 37 % 256)]) {
    const gray = Uint8Array.from(values);
    checkQuarter(gray, new Uint8Array(gray.length), gray.length, 1);
    checkQuarter(gray, new Uint8Array(gray.length).fill(1), gray.length, 1);
  }
  assert.equal(quarterHistogram(Uint8Array.from({ length: 256 }, (_, i) => i), new Uint8Array(256), 256, 0, 0, 255, 0), 64);
  for (let trial = 0; trial < 100; trial++) {
    const width = 1 + random() % 63, height = 1 + random() % 47;
    const gray = Uint8Array.from({ length: width * height }, () => random() % 256);
    const mask = Uint8Array.from({ length: gray.length }, () => random() % 4 ? 0 : 1);
    checkQuarter(gray, mask, width, height);
    for (const rect of [{ x: 0, y: 0, width, height }, { x: -5.3, y: -2.7, width: width / 2, height: height / 2 },
      { x: width + 1, y: height + 1, width: 9, height: 7 }]) {
      compareComplete(gray, mask, width, height, rect, 1 + random() % 80);
    }
  }
  // A bright two-pixel ring must reach the nonzero outline-width branch.
  const width = 91, height = 73, gray = new Uint8Array(width * height).fill(10), mask = new Uint8Array(gray.length);
  for (let y = 20; y <= 50; y++) for (let x = 25; x <= 65; x++) {
    const text = y >= 22 && y <= 48 && x >= 27 && x <= 63;
    gray[y * width + x] = text ? 0 : 210; mask[y * width + x] = text ? 1 : 0;
  }
  assert.equal(compareComplete(gray, mask, width, height, { x: 0, y: 0, width, height }, 30), 2);
  compareComplete(gray, new Uint8Array(mask.length).fill(1), width, height, { x: 0, y: 0, width, height }, 30);
  compareComplete(gray, new Uint8Array(mask.length), width, height, { x: 0, y: 0, width, height }, 30);

  // A few array-only timings describe the selector, not the browser mask stage.
  const selectorTimings = [];
  for (const [roiWidth, roiHeight] of [[31, 127], [127, 511], [333, 667]]) {
    const samples = Uint8Array.from({ length: roiWidth * roiHeight }, () => random() % 256);
    const outside = Uint8Array.from({ length: samples.length }, () => random() % 5 ? 0 : 1);
    const referenceStart = performance.now();
    const expected = quarterSort(samples, outside, roiWidth, 0, 0, roiWidth - 1, roiHeight - 1);
    const referenceMs = performance.now() - referenceStart, candidateStart = performance.now();
    assert.equal(quarterHistogram(samples, outside, roiWidth, 0, 0, roiWidth - 1, roiHeight - 1), expected);
    selectorTimings.push({ roiWidth, roiHeight, referenceMs, histogramMs: performance.now() - candidateStart });
  }
  const distanceSortTimings = [];
  for (const count of [32, 256, 1024]) {
    const distances = Array.from({ length: count }, () => 1 + random() % 18);
    const start = performance.now();
    distances.sort((a, b) => a - b);
    distanceSortTimings.push({ count, sortMs: performance.now() - start, median: distances[Math.floor(count / 2)] });
  }
  console.log(JSON.stringify({ result: 'Q1-and-full-detectOutlineWidth-identical-inputs-unchanged',
    selectorsChecked, completeFunctionsChecked, selectorTimings, distanceSortTimings,
    caveat: 'CPU selector timings are synthetic; actual mask/full PNG/DOM speed and RGBA gate are separate' }, null, 2));
} finally {
  delete flags.__shinobuColdStartMaskHistogram;
}
