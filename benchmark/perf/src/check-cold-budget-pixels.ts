import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { connectedComponents, toMaskCanvas } from '../../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms';
import { blobToBase64, canvasToPngBlobSync } from '../../../packages/image-pipeline/src/protocol/blobCodec';
import type { PipelineCanvas, PipelineImageData, PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';

// Exercise the private convolution directly without adding a production export.
const orderSource = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/readingOrder.ts', import.meta.url), 'utf8');
const blurSource = orderSource.slice(orderSource.indexOf('const panelDetectMaxSide'), orderSource.indexOf('function toGrayscale'))
  + orderSource.slice(orderSource.indexOf('function blurGaussian7'), orderSource.indexOf('function thresholdToBinary'));
const flags = globalThis as typeof globalThis & {
  __shinobuColdStartPixelFastPath?: boolean;
  __shinobuColdStartInpaintPixels?: boolean;
};
const blur = new Function('globalThis', 'clamp', ts.transpileModule(blurSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn blurGaussian7;')(
  flags, (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)),
) as (src: Uint8Array, width: number, height: number) => Uint8Array;

const timings: Array<{ operation: string; baselineMs: number; candidateMs: number }> = [];
function pair<T>(operation: string, run: () => T, check: (baseline: T, candidate: T) => void): void {
  const values: T[] = [];
  const elapsed: number[] = [];
  for (const fast of [false, true]) {
    flags.__shinobuColdStartPixelFastPath = fast;
    const start = performance.now();
    values.push(run());
    elapsed.push(performance.now() - start);
  }
  check(values[0], values[1]);
  timings.push({ operation, baselineMs: elapsed[0], candidateMs: elapsed[1] });
}
// Only conversion is mocked: browser resampling must pass the full RGBA gate.
const platform = {
  createCanvas(width: number, height: number) {
    let data = new Uint8ClampedArray(width * height * 4);
    const ctx = {
      imageSmoothingEnabled: true,
      createImageData: () => ({ width, height, data: new Uint8ClampedArray(data.length) }),
      putImageData: (image: { data: Uint8ClampedArray }) => { data = image.data.slice(); },
      getImageData: () => ({ width, height, data: data.slice() }),
      drawImage() {
        assert.equal(ctx.imageSmoothingEnabled, true);
        for (let p = 0; p < data.length; p += 4) data[p] = (p / 4 * 37) % 256;
      },
    };
    return { width, height, getContext: () => ctx } as unknown as PipelineCanvas;
  },
} as PlatformProvider;
const inpaintSource = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/inpaint.ts', import.meta.url), 'utf8');
const inpaintFunctions = new Function('globalThis', ts.transpileModule(inpaintSource.slice(
  inpaintSource.indexOf('function inpaintPixelFastPath'), inpaintSource.indexOf('function isLikelyInvalidInpaintResult'),
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export\s+/gm, '')
  + '\nreturn { readMaskBinary, composeInpaintResult };')(flags) as {
    readMaskBinary: (mask: PipelineCanvas, width: number, height: number, platform: PlatformProvider) => Float32Array | Uint8Array;
    composeInpaintResult: (source: Uint8ClampedArray, inpainted: Uint8ClampedArray, mask: Float32Array,
      width: number, height: number, platform: PlatformProvider, sourceImage?: PipelineImageData) => PipelineCanvas;
  };
const binaryMasks = [false, true].map((fast) => {
  flags.__shinobuColdStartInpaintPixels = fast;
  return inpaintFunctions.readMaskBinary(platform.createCanvas(16, 16), 16, 16, platform);
});
assert.deepEqual(Array.from(binaryMasks[0]), Array.from(binaryMasks[1]));
assert(binaryMasks[0] instanceof Float32Array && binaryMasks[1] instanceof Uint8Array);
for (const offset of [0, 1]) {
  const width = 61;
  const height = 47;
  const length = width * height * 4;
  const source = new Uint8ClampedArray(new ArrayBuffer(length + offset), offset, length);
  const inpainted = new Uint8ClampedArray(new ArrayBuffer(length + offset), offset, length);
  for (let p = 0; p < length; p += 1) {
    source[p] = p * 17 % 256;
    inpainted[p] = p * 53 % 256;
  }
  const mask = Float32Array.from({ length: width * height }, (_, i) => [0, 0.49, 0.5, 1, NaN][i % 5]);
  const outputs = [false, true].map((fast) => {
    flags.__shinobuColdStartInpaintPixels = fast;
    return inpaintFunctions.composeInpaintResult(source, inpainted, mask, width, height, platform)
      .getContext('2d')!.getImageData(0, 0, width, height).data;
  });
  assert.deepEqual(outputs[0], outputs[1]);
  for (let p = 3; p < length; p += 4) assert.equal(outputs[1][p], 255);
  const sourceSnapshot = source.slice();
  const ownedSourceCopy = { width, height, data: source.slice() };
  const reused = inpaintFunctions.composeInpaintResult(ownedSourceCopy.data, inpainted, mask,
    width, height, platform, ownedSourceCopy).getContext('2d')!.getImageData(0, 0, width, height).data;
  assert.deepEqual(reused, outputs[0]);
  assert.deepEqual(source, sourceSnapshot);
}
for (const [width, height] of [[1, 1], [2, 3], [3, 2], [5, 7], [8, 9], [61, 47], [1284, 1800]]) {
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => (i * 31 + Math.floor(i / width) * 17) % 256);
  pair(`gaussian-${width}x${height}`, () => blur(pixels, width, height), assert.deepEqual);
}
for (const [width, height, dense] of [[61, 47, 0], [256, 128, 1], [1461, 2048, 0]]) {
  const mask = Uint8Array.from({ length: width * height }, (_, i) => (
    dense ? 1 : (i % width % 31 < 13 && Math.floor(i / width) % 41 < 25 ? 1 : 0)
  ));
  pair(`components-${width}x${height}`, () => connectedComponents(mask, width, height), assert.deepEqual);
}
for (const [width, height, outW, outH] of [[2, 3, 7, 11], [61, 47, 73, 93], [1461, 2048, 2921, 4096]]) {
  const mask = Uint8Array.from({ length: width * height }, (_, i) => i % 37 < 19 ? 1 : 0);
  pair(`mask-conversion-mock-${outW}x${outH}`, () => toMaskCanvas(mask, width, height, outW, outH, platform), (a, b) => {
    assert.deepEqual(a.getContext('2d')!.getImageData(0, 0, outW, outH).data,
      b.getContext('2d')!.getImageData(0, 0, outW, outH).data);
  });
}
const canvas = { toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==' } as PipelineCanvas;
flags.__shinobuColdStartPixelFastPath = false;
const baselineBlob = canvasToPngBlobSync(canvas);
flags.__shinobuColdStartPixelFastPath = true;
const candidateBlob = canvasToPngBlobSync(canvas);
assert.deepEqual(await baselineBlob.arrayBuffer(), await candidateBlob.arrayBuffer());
assert.equal(await blobToBase64(candidateBlob), canvas.toDataURL('image/png').split(',')[1]);
// Arbitrary Blob values still take the original FileReader path in browsers.
await assert.rejects(blobToBase64(new Blob(['uncached'])), /FileReader/);
delete flags.__shinobuColdStartPixelFastPath;
delete flags.__shinobuColdStartInpaintPixels;
console.log(JSON.stringify({ outputEquality: 'passed', timings }, null, 2));
