import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Exercise the actual source encoder without building/loading models or an extension.
const platformSource = readFileSync(new URL('../../../apps/extension/src/shared/browserPipelinePlatform.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('browserPipelinePlatform.ts', platformSource, ts.ScriptTarget.ES2022, true);
let encoderMethod = '';
function findEncoder(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'encodeCanvasToPng') {
    encoderMethod = node.getText(ast);
  }
  ts.forEachChild(node, findEncoder);
}
findEncoder(ast);
if (!encoderMethod) throw new Error('PNG encoder source not found');
const codecSource = readFileSync(new URL('../../../packages/image-pipeline/src/protocol/blobCodec.ts', import.meta.url), 'utf8')
  .replace(/^import type[^\n]+\n/m, '').replace(/^export\s+/gm, '');
const code = ts.transpileModule(`${codecSource}\nconst encoder = { ${encoderMethod} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const fixturePath = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const fixture = readFileSync(fixturePath ?? new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const rounds = Number(process.argv.find((arg) => arg.startsWith('--rounds='))?.slice('--rounds='.length) ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('rounds must be 1..20');
const browser = await chromium.launch({
  executablePath: process.env.COLD_BUDGET_BROWSER || chromium.executablePath(), headless: false,
});
try {
  const page = await browser.newPage();
  const result = await page.evaluate(`(async () => {
    ${code}
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable');
    globalThis.__shinobuColdStartPixelFastPath = false;
    function equal(a, b, label) {
      if (a.length !== b.length) throw new Error(label + ': length');
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
        throw new Error(label + ': byte ' + i + ' ' + a[i] + ' != ' + b[i]);
      }
    }
    function median(values) {
      const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    const fixtureBytes = Uint8Array.from(atob(${JSON.stringify(fixture.toString('base64'))}), char => char.charCodeAt(0));
    const fixtureImage = await createImageBitmap(new Blob([fixtureBytes], { type: 'image/png' }));
    async function decode(blob, width, height) {
      if (blob.type !== 'image/png') throw new Error('PNG content type mismatch');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      equal(bytes.subarray(0, 8), Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), 'PNG signature');
      const image = await createImageBitmap(blob);
      if (image.width !== width || image.height !== height) throw new Error('decoded dimensions changed');
      const surface = document.createElement('canvas');
      surface.width = width; surface.height = height;
      const context = surface.getContext('2d', { willReadFrequently: true });
      context.globalCompositeOperation = 'copy';
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, width, height).data;
      image.close(); surface.width = 0; surface.height = 0;
      return rgba;
    }
    const checks = [];
    for (const cpuCanvas of [false, true]) for (const kind of ['tiny', 'opaque', 'alpha', 'debug', 'no-text', 'fixture']) {
      const width = kind === 'fixture' ? fixtureImage.width : kind === 'tiny' ? 1 : 257;
      const height = kind === 'fixture' ? fixtureImage.height : kind === 'tiny' ? 1 : 131;
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: cpuCanvas });
      if (kind === 'fixture') context.drawImage(fixtureImage, 0, 0);
      else {
        const pixels = context.createImageData(width, height);
        for (let i = 0, p = 0; i < width * height; i++, p += 4) {
          pixels.data[p] = i * 17 % 256; pixels.data[p + 1] = i * 53 % 256; pixels.data[p + 2] = i * 31 % 256;
          pixels.data[p + 3] = kind === 'alpha' || kind === 'debug' ? i % 256 : 255;
        }
        context.putImageData(pixels, 0, 0);
        if (kind === 'debug') {
          context.strokeStyle = 'rgba(223,17,91,0.37)'; context.lineWidth = 1.3;
          context.strokeRect(3.2, 7.4, 105.7, 93.3);
          context.fillStyle = 'rgba(27,117,239,0.23)'; context.fillRect(11, 13, 127, 89);
          context.fillStyle = '#fff'; context.font = '13px sans-serif'; context.fillText('debug labels', 17, 37);
        }
        if (kind === 'no-text') { context.fillStyle = '#f9efd8'; context.fillRect(0, 0, width, height); }
      }
      const before = context.getImageData(0, 0, width, height).data;
      const timing = { baseline: [], offscreen: [] }, encoded = {};
      for (let round = 0; round < ${rounds}; round++) for (const fast of (round % 2 ? [true, false] : [false, true])) {
        globalThis.__shinobuColdStartOffscreenPng = fast;
        const start = performance.now();
        const blob = await encoder.encodeCanvasToPng(canvas);
        const durationMs = performance.now() - start;
        const key = fast ? 'offscreen' : 'baseline';
        timing[key].push(durationMs); encoded[key] = blob;
      }
      const baseline = await decode(encoded.baseline, width, height);
      const offscreen = await decode(encoded.offscreen, width, height);
      equal(baseline, offscreen, kind + ' decoded RGBA');
      equal(before, context.getImageData(0, 0, width, height).data, kind + ' source not mutated');
      const alpha = new Set();
      for (let p = 3; p < baseline.length; p += 4) alpha.add(baseline[p]);
      if ((kind === 'alpha' || kind === 'debug') && alpha.size < 200) throw new Error('alpha edge fixture coverage too small');
      checks.push({ kind, cpuCanvas, width, height, result: 'decoded-RGBA-identical',
        alphaValues: alpha.size, baselineBytes: encoded.baseline.size, offscreenBytes: encoded.offscreen.size,
        baselineMs: timing.baseline, offscreenMs: timing.offscreen,
        medianBaselineMs: median(timing.baseline), medianOffscreenMs: median(timing.offscreen) });
      canvas.width = 0; canvas.height = 0;
    }
    fixtureImage.close();
    return { checks, userAgent: navigator.userAgent, rounds: ${rounds}, timingIncludes: 'complete PNG and candidate surface cleanup' };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
