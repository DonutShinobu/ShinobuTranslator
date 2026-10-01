import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ts from 'typescript';

// CPU only. libvips resampling is not a Chromium Canvas pixel-quality gate.
// Extract the current private functions without adding production exports.
const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/readingOrder.ts', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('const panelDetectMaxSide'), source.indexOf('function mapPanelToOriginal'));
const flags = { __shinobuColdStartPixelFastPath: true };
const fns = new Function('globalThis', 'clamp', ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn { toGrayscale, blurGaussian7, thresholdToBinary, addWhiteBorderAndInvert, connectedComponents };')(
  flags, (value, min, max) => Math.max(min, Math.min(max, value)),
);
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Check 8-connectivity, no horizontal wrapping, and row-major component order.
for (const { width, height, mask, expected } of [
  { width: 3, height: 3, mask: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    expected: [{ rect: { x: 0, y: 0, width: 3, height: 3 }, area: 3 }] },
  { width: 4, height: 2, mask: [0, 0, 0, 1, 1, 0, 0, 0],
    expected: [{ rect: { x: 3, y: 0, width: 1, height: 1 }, area: 1 },
      { rect: { x: 0, y: 1, width: 1, height: 1 }, area: 1 }] },
  { width: 1, height: 3, mask: [1, 1, 1],
    expected: [{ rect: { x: 0, y: 0, width: 1, height: 3 }, area: 3 }] },
  { width: 2, height: 2, mask: [0, 0, 0, 0], expected: [] },
]) {
  const input = Uint8Array.from(mask);
  assert.deepEqual(fns.connectedComponents(input, width, height), expected);
  assert.deepEqual(Array.from(input), mask);
}

const fixtureArgument = process.argv.find(arg => arg.startsWith('--fixture='));
const fixture = fixtureArgument?.slice('--fixture='.length)
  ?? fileURLToPath(new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const metadataStart = performance.now();
const image = await sharp(fixture).metadata();
const metadataMs = performance.now() - metadataStart;
const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
const width = Math.max(1, Math.round(image.width * scale));
const height = Math.max(1, Math.round(image.height * scale));
const decodeResizeStart = performance.now();
const decoded = await sharp(fixture).resize(width, height, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
assert.equal(decoded.info.channels, 4);
const rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
const decodeResizeMs = performance.now() - decodeResizeStart;

const records = [];
let previousComponents;
for (const invocation of ['first', 'second']) {
  const times = {};
  const stage = (name, run) => {
    const startedAt = performance.now();
    const output = run();
    times[name] = performance.now() - startedAt;
    return output;
  };
  const gray = stage('grayMs', () => fns.toGrayscale(rgba));
  const blurred = stage('gaussianMs', () => fns.blurGaussian7(gray, width, height));
  const binary = stage('thresholdMs', () => fns.thresholdToBinary(blurred, 200));
  const border = stage('borderInvertMs', () => fns.addWhiteBorderAndInvert(binary, width, height, 10));
  const components = stage('componentsMs', () => fns.connectedComponents(border.mask, border.width, border.height));
  if (previousComponents) assert.deepEqual(components, previousComponents);
  previousComponents = components;
  const foregroundPixels = border.mask.reduce((sum, pixel) => sum + (pixel !== 0 ? 1 : 0), 0);
  assert.equal(components.reduce((sum, component) => sum + component.area, 0), foregroundPixels);
  records.push({ invocation, ...times, totalAlgorithmMs: Object.values(times).reduce((sum, time) => sum + time, 0),
    foregroundPixels, componentCount: components.length,
    maskSha256: sha256(border.mask), componentsSha256: sha256(JSON.stringify(components)) });
}
console.log(JSON.stringify({ sourceSha256: sha256(source), fixture,
  sourceWidth: image.width, sourceHeight: image.height, width, height, maxSide: 1800,
  pixelFastPath: true, metadataMs, decodeResizeMs,
  pixelBackend: 'sharp/libvips Lanczos3; does not establish browser timings or resampling equality',
  syntheticChecks: 'passed', records }, null, 2));
