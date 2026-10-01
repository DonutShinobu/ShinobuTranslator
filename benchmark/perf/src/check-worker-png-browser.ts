import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Root runs this native-browser gate serially. No models or extension build are
// needed; the encoder/Worker below are compiled from the actual candidate source.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const platformSource = source('../../../apps/extension/src/shared/browserPipelinePlatform.ts');
const ast = ts.createSourceFile('browserPipelinePlatform.ts', platformSource, ts.ScriptTarget.ES2022, true);
let encoderMethod = '';
function findEncoder(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'encodeCanvasToPng') encoderMethod = node.getText(ast);
  ts.forEachChild(node, findEncoder);
}
findEncoder(ast);
if (!encoderMethod) throw new Error('PNG encoder source not found');
const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } };
const workerCode = ts.transpileModule(source('../../../apps/extension/src/shared/pngEncodeWorker.ts'), options).outputText;
const helperSource = source('../../../apps/extension/src/shared/pngWorkerEncoder.ts');
const workerUrlExpression = "new URL('./pngEncodeWorker.ts', import.meta.url)";
if (!helperSource.includes(workerUrlExpression)) throw new Error('Worker URL expression changed; update native harness');
const helperCode = ts.transpileModule(helperSource.replace(workerUrlExpression,
  "new URL('/pngEncodeWorker.js', location.href)"), options).outputText.replace(/^export\s+/gm, '');
const codecSource = source('../../../packages/image-pipeline/src/protocol/blobCodec.ts')
  .replace(/^import type[^\n]+\n/m, '').replace(/^export\s+/gm, '');
const encoderCode = ts.transpileModule(`${codecSource}\nconst encoder = { ${encoderMethod} };`, options).outputText;
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const fixture = fixturePath ? readFileSync(fixturePath)
  : readFileSync(new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.slice('--rounds='.length) ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('rounds must be 1..20');
const server = createServer((request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; worker-src 'self'; img-src 'self' blob:");
  if (request.url === '/pngEncodeWorker.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(workerCode);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>PNG Worker native quality gate</title>');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Native test server address unavailable');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.COLD_BUDGET_BROWSER || chromium.executablePath(), headless: false });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(`(async () => {
    ${helperCode}
    ${encoderCode}
    if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') throw new Error('PNG Worker APIs unavailable');
    globalThis.__shinobuColdStartOffscreenPng = false;
    globalThis.__shinobuColdStartPixelFastPath = false;
    const profile = [];
    globalThis.__shinobuColdStartInitMark = record => profile.push(record);
    function equal(a, b, label) {
      if (a.length !== b.length) throw new Error(label + ': length');
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(label + ': byte ' + i + ' ' + a[i] + ' != ' + b[i]);
    }
    function median(values) {
      const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    const fixtureBytes = Uint8Array.from(atob(${JSON.stringify(fixture.toString('base64'))}), char => char.charCodeAt(0));
    const fixtureImage = await createImageBitmap(new Blob([fixtureBytes], { type: 'image/png' }));
    async function decode(blob, width, height, colorSpace) {
      if (blob.type !== 'image/png') throw new Error('PNG content type mismatch');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      equal(bytes.subarray(0, 8), Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), 'PNG signature');
      const image = await createImageBitmap(blob);
      if (image.width !== width || image.height !== height) throw new Error('decoded dimensions changed');
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace });
        context.globalCompositeOperation = 'copy'; context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      } finally { image.close(); canvas.width = 0; canvas.height = 0; }
    }
    const checks = [], skipped = [];
    for (const colorSpace of ['srgb', 'display-p3']) for (const cpuCanvas of [false, true]) {
      const kinds = colorSpace === 'srgb' ? ['tiny', 'opaque', 'alpha', 'debug', 'no-text', 'fixture'] : ['opaque', 'alpha', 'debug'];
      for (const kind of kinds) {
        const width = kind === 'fixture' ? fixtureImage.width : kind === 'tiny' ? 1 : 257;
        const height = kind === 'fixture' ? fixtureImage.height : kind === 'tiny' ? 1 : 131;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: cpuCanvas, colorSpace });
        if (context.getContextAttributes().colorSpace !== colorSpace) {
          skipped.push({ colorSpace, cpuCanvas, kind, reason: 'source color space unavailable' });
          canvas.width = 0; canvas.height = 0; continue;
        }
        if (kind === 'fixture') context.drawImage(fixtureImage, 0, 0);
        else {
          const pixels = context.createImageData(width, height);
          for (let i = 0, p = 0; i < width * height; i++, p += 4) {
            pixels.data[p] = i * 17 % 256; pixels.data[p + 1] = i * 53 % 256; pixels.data[p + 2] = i * 31 % 256;
            pixels.data[p + 3] = kind === 'alpha' || kind === 'debug' ? i % 256 : 255;
          }
          context.putImageData(pixels, 0, 0);
          if (kind === 'debug') {
            context.strokeStyle = 'rgba(223,17,91,0.37)'; context.lineWidth = 1.3; context.strokeRect(3.2, 7.4, 105.7, 93.3);
            context.fillStyle = 'rgba(27,117,239,0.23)'; context.fillRect(11, 13, 127, 89);
            context.fillStyle = '#fff'; context.font = '13px sans-serif'; context.fillText('debug labels', 17, 37);
          }
          if (kind === 'no-text') { context.fillStyle = '#f9efd8'; context.fillRect(0, 0, width, height); }
        }
        const before = context.getImageData(0, 0, width, height).data;
        const timing = { baseline: [], bitmap: [], rgba: [] }, encoded = {};
        const profiles = { bitmap: [], rgba: [] };
        for (let round = 0; round < ${rounds}; round++) {
          const modes = ['baseline', 'bitmap', 'rgba'];
          for (let shift = 0; shift < modes.length; shift++) {
            const mode = modes[(round + shift) % modes.length];
            globalThis.__shinobuColdStartWorkerPng = mode !== 'baseline';
            globalThis.__shinobuColdStartWorkerPngRgba = mode === 'rgba';
            const profileStart = profile.length, start = performance.now();
            const blob = await encoder.encodeCanvasToPng(canvas);
            timing[mode].push(performance.now() - start); encoded[mode] = blob;
            if (mode !== 'baseline') profiles[mode].push(...profile.slice(profileStart));
          }
        }
        const baseline = await decode(encoded.baseline, width, height, colorSpace);
        for (const mode of ['bitmap', 'rgba']) equal(baseline, await decode(encoded[mode], width, height, colorSpace), kind + ' ' + mode + ' decoded RGBA');
        if (colorSpace === 'display-p3') {
          const displayBaseline = await decode(encoded.baseline, width, height, 'srgb');
          for (const mode of ['bitmap', 'rgba']) equal(displayBaseline, await decode(encoded[mode], width, height, 'srgb'), kind + ' ' + mode + ' sRGB display');
        }
        equal(before, context.getImageData(0, 0, width, height).data, kind + ' source not mutated');
        const alpha = new Set(); for (let p = 3; p < baseline.length; p += 4) alpha.add(baseline[p]);
        if ((kind === 'alpha' || kind === 'debug') && alpha.size < 200) throw new Error('alpha edge fixture coverage too small');
        checks.push({ kind, colorSpace, cpuCanvas, width, height, result: 'both-Worker-paths-decoded-RGBA-identical', alphaValues: alpha.size,
          pngBytes: Object.fromEntries(Object.entries(encoded).map(([mode, blob]) => [mode, blob.size])),
          timing, medianMs: Object.fromEntries(Object.entries(timing).map(([mode, values]) => [mode, median(values)])), profiles });
        canvas.width = 0; canvas.height = 0;
      }
    }
    fixtureImage.close(); delete globalThis.__shinobuColdStartInitMark;
    return { checks, skipped, userAgent: navigator.userAgent, rounds: ${rounds},
      timingIncludes: 'complete PNG plus each short Worker startup, snapshot, transfer, cleanup, and terminate',
      caveat: 'native foreground microbenchmark; full extension offscreen first-image timing is separate' };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
