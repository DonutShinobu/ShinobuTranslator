import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Root runs this standalone native gate serially. Nothing is added to the
// extension build or protocol. Worker snapshot/delivery uses the actual helper.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
}}).outputText.replace(/^export\s+/gm, '');
const nativeWorker = transpile(source('../../../apps/extension/src/shared/pngEncodeWorker.ts'));
const candidate = transpile(source('./png-none-experiment.ts'));
const helperSource = source('../../../apps/extension/src/shared/pngWorkerEncoder.ts');
const workerUrl = "new URL('./pngEncodeWorker.ts', import.meta.url)", returnBlob = 'return result.blob!;';
if (!helperSource.includes(workerUrl) || !helperSource.includes(returnBlob)) throw new Error('Actual PNG Worker helper changed; update harness');
const helperCode = transpile(helperSource.replace(workerUrl, "new URL('/bench-png-worker.js?mode=' + benchmarkMode, location.href)")
  .replace(returnBlob, 'lastBenchmarkDetail = result.benchmarkDetail; return result.blob!;'));
const workerCode = `${nativeWorker}\n${candidate}\n
  async function encodeOpaqueNative(input) {
    const startedAt = performance.now(); let scratch, target;
    let readMs = 0, alphaScanMs = 0;
    const fallback = async reason => {
      const result = await encodeWorkerPng(input);
      return { ...result, benchmarkDetail: { actual: 'native-fallback', reason, readMs, alphaScanMs,
        drawMs: result.drawMs, encodeMs: result.encodeMs, workerTotalMs: performance.now() - startedAt } };
    };
    try {
      if (input.colorSpace !== 'srgb') return await fallback('non-sRGB-source');
      const width = input.kind === 'image-bitmap' ? input.bitmap.width : input.width;
      const height = input.kind === 'image-bitmap' ? input.bitmap.height : input.height;
      let pixels;
      if (input.kind === 'rgba') pixels = input.pixels;
      else {
        // Bitmap mode pays its complete opacity readback cost inside the Worker.
        const readStarted = performance.now(); scratch = new OffscreenCanvas(width, height);
        const context = scratch.getContext('2d', { colorSpace: 'srgb' });
        if (!context) throw new Error('Opacity scan Canvas unavailable');
        const attrs = context.getContextAttributes();
        if (attrs.colorSpace !== 'srgb' || attrs.colorType !== 'unorm8') return await fallback('unknown-format');
        context.globalCompositeOperation = 'copy'; context.drawImage(input.bitmap, 0, 0);
        pixels = context.getImageData(0, 0, width, height).data; readMs = performance.now() - readStarted;
      }
      const scanStarted = performance.now(); let opaque = true;
      for (let p = 3; p < pixels.length; p += 4) if (pixels[p] !== 255) { opaque = false; break; }
      alphaScanMs = performance.now() - scanStarted;
      if (!opaque) return await fallback('nonopaque-pixels');
      // Only the export surface changes alpha. Typesetting and source Canvas
      // keep their original contexts, avoiding any text antialiasing change.
      target = new OffscreenCanvas(width, height);
      const context = target.getContext('2d', { colorSpace: 'srgb', alpha: false });
      const attrs = context?.getContextAttributes();
      if (!context || attrs.alpha !== false || attrs.colorSpace !== 'srgb' || attrs.colorType !== 'unorm8') return await fallback('opaque-target-unavailable');
      const drawStarted = performance.now();
      if (input.kind === 'image-bitmap') { context.globalCompositeOperation = 'copy'; context.drawImage(input.bitmap, 0, 0); }
      else context.putImageData(new ImageData(pixels, width, height, { colorSpace: 'srgb' }), 0, 0);
      const drawMs = performance.now() - drawStarted, encodeStarted = performance.now();
      const blob = await target.convertToBlob({ type: 'image/png' }), encodeMs = performance.now() - encodeStarted;
      return { blob, drawMs, encodeMs, benchmarkDetail: { actual: 'native-rgb', readMs, alphaScanMs, drawMs, encodeMs,
        workerTotalMs: performance.now() - startedAt, targetAlpha: attrs.alpha } };
    } finally {
      if (input.kind === 'image-bitmap') input.bitmap.close();
      if (scratch) { scratch.width = 0; scratch.height = 0; }
      if (target) { target.width = 0; target.height = 0; }
    }
  }
  self.onmessage = event => {
    const input = event.data, mode = new URL(self.location.href).searchParams.get('mode');
    const run = async () => {
      if (mode === 'native-rgb-bitmap' || mode === 'native-rgb-rgba') return await encodeOpaqueNative(input);
      if (mode === 'native-worker' || mode === 'native-worker-rgba') {
        const result = await encodeWorkerPng(input);
        return { ...result, benchmarkDetail: { actual: 'native', drawMs: result.drawMs, encodeMs: result.encodeMs } };
      }
      const width = input.bitmap.width, height = input.bitmap.height, surface = new OffscreenCanvas(width, height);
      try {
        const context = surface.getContext('2d', { colorSpace: input.colorSpace });
        if (!context) throw new Error('PNG benchmark Worker Canvas unavailable');
        const drawStarted = performance.now();
        context.globalCompositeOperation = 'copy'; context.drawImage(input.bitmap, 0, 0);
        const drawMs = performance.now() - drawStarted, encodeStarted = performance.now(), attrs = context.getContextAttributes();
        // The minimal envelope describes only 8-bit sRGB. Never silently convert
        // P3, float16 or unknown formats to sRGB as a purported optimization.
        if (input.colorSpace !== 'srgb' || attrs.colorSpace !== 'srgb' || attrs.colorType !== 'unorm8'
          || typeof CompressionStream === 'undefined') {
          const blob = await surface.convertToBlob({ type: 'image/png' }), encodeMs = performance.now() - encodeStarted;
          return { blob, drawMs, encodeMs, benchmarkDetail: { actual: 'native-fallback',
            reason: input.colorSpace !== 'srgb' ? 'non-sRGB-source' : 'unknown-format-or-API', drawMs, encodeMs } };
        }
        const readStarted = performance.now(), rgba = context.getImageData(0, 0, width, height).data;
        const readMs = performance.now() - readStarted;
        const result = await encodeNoneFilterPng(rgba, width, height, mode === 'none-rgb');
        const encodeMs = performance.now() - encodeStarted;
        return { blob: result.blob, drawMs, encodeMs, benchmarkDetail: { actual: 'none-deflate',
          ...result.detail, readMs, drawMs, encodeMs, rgbaFallback: mode === 'none-rgb' && result.detail.channels === 4 } };
      } finally { input.bitmap.close(); surface.width = 0; surface.height = 0; }
    };
    void run().then(result => self.postMessage(result), error => self.postMessage({ error: String(error) }));
  };
`;
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const fixture = fixturePath ? readFileSync(fixturePath)
  : readFileSync(new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.slice('--rounds='.length) ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('rounds must be 1..20');
const fixtureOnly = process.argv.includes('--fixture-only');
const opaqueOnly = process.argv.includes('--opaque-only');
const script = `(async () => {
  let benchmarkMode = 'native-worker', lastBenchmarkDetail;
  ${helperCode}
  if (typeof CompressionStream === 'undefined' || typeof Worker === 'undefined') throw new Error('Native CompressionStream/Worker unavailable');
  globalThis.__shinobuColdStartWorkerPngRgba = false;
  const profiles = []; globalThis.__shinobuColdStartInitMark = record => profiles.push(record);
  const fixtureBlob = await (await fetch('/fixture.png')).blob(), fixtureBitmap = await createImageBitmap(fixtureBlob);
  function equal(a, b, label) {
    if (a.length !== b.length) throw new Error(label + ': length');
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(label + ': byte ' + i + ' ' + a[i] + ' != ' + b[i]);
  }
  function median(values) { const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; }
  function makeSource(kind, width, height, colorSpace, cpu) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { colorSpace, willReadFrequently: cpu });
    if (context.getContextAttributes().colorSpace !== colorSpace) throw new Error('Requested source color space unavailable: ' + colorSpace);
    if (kind === 'fixture') context.drawImage(fixtureBitmap, 0, 0);
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
    return canvas;
  }
  function imageRgba(image, width, height, colorSpace) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext('2d', { colorSpace, willReadFrequently: true });
      context.globalCompositeOperation = 'copy'; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, width, height).data;
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  async function show(blob, width, height) {
    if (blob.type !== 'image/png' || !blob.size) throw new Error('Complete PNG Blob required');
    const image = document.createElement('img'), url = URL.createObjectURL(blob); image.style.maxWidth = '300px';
    const startedAt = performance.now(); let loadMs = null;
    image.onload = () => { loadMs = performance.now() - startedAt; };
    try {
      // Match the product's complete PNG -> BlobURL -> one img.decode -> RAF endpoint.
      document.body.append(image); image.src = url;
      await image.decode(); const decodeMs = performance.now() - startedAt;
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('PNG dimensions changed');
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { image, url, timing: { loadMs, decodeMs, rafMs: performance.now() - startedAt - decodeMs,
        displayMs: performance.now() - startedAt } };
    } catch (error) { URL.revokeObjectURL(url); image.remove(); throw error; }
  }
  function release(shown) { URL.revokeObjectURL(shown.url); shown.image.remove(); }
  async function inspect(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
    equal(bytes.subarray(0, 8), Uint8Array.of(137,80,78,71,13,10,26,10), 'PNG signature');
    const idats = []; let width, height, colorType, bitDepth, interlace, idatChunks = 0;
    for (let p = 8; p < bytes.length;) {
      const length = view.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (type === 'IHDR') { width = view.getUint32(p + 8); height = view.getUint32(p + 12);
        bitDepth = bytes[p + 16]; colorType = bytes[p + 17]; interlace = bytes[p + 20]; }
      if (type === 'IDAT') { idats.push(bytes.subarray(p + 8, p + 8 + length)); idatChunks++; }
      p += length + 12;
    }
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (bitDepth !== 8 || interlace !== 0 || !channels) throw new Error('PNG filter probe expects RGB/RGBA8 non-interlaced');
    const raw = new Uint8Array(await new Response(new Blob(idats).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const rowBytes = width * channels, filters = [0,0,0,0,0];
    if (raw.length !== (rowBytes + 1) * height) throw new Error('PNG inflated size mismatch');
    for (let y = 0; y < height; y++) filters[raw[y * (rowBytes + 1)]]++;
    return { width, height, bitDepth, colorType, interlace, idatChunks, inflatedBytes: raw.length, filters };
  }
  const checks = [], originalFixture = await inspect(fixtureBlob);
  for (const colorSpace of ['srgb', 'display-p3']) for (const cpu of [false, true]) {
    if (${fixtureOnly} && colorSpace !== 'srgb') continue;
    const kinds = ${fixtureOnly} ? ['fixture'] : colorSpace === 'srgb'
      ? ['tiny', 'opaque', 'alpha', 'debug', 'no-text', 'fixture'] : ['opaque', 'alpha', 'debug'];
    for (const kind of kinds) {
      const width = kind === 'fixture' ? fixtureBitmap.width : kind === 'tiny' ? 1 : 257;
      const height = kind === 'fixture' ? fixtureBitmap.height : kind === 'tiny' ? 1 : 131;
      // Canonical native PNG and source pixels come from an independent surface.
      // Timed surfaces are never read before their Worker snapshot/encoding.
      const reference = makeSource(kind, width, height, colorSpace, cpu), referenceContext = reference.getContext('2d');
      benchmarkMode = 'native-worker';
      globalThis.__shinobuColdStartWorkerPngRgba = false;
      const referenceBlob = await encodeCanvasToPngInWorker(reference), shownReference = await show(referenceBlob, width, height);
      const expected = imageRgba(shownReference.image, width, height, colorSpace);
      const expectedDisplay = colorSpace === 'display-p3' ? imageRgba(shownReference.image, width, height, 'srgb') : null;
      const sourcePixels = referenceContext.getImageData(0, 0, width, height).data;
      release(shownReference); reference.width = 0; reference.height = 0;
      const modes = ['native-worker', 'native-worker-rgba', 'native-rgb-bitmap', 'native-rgb-rgba'];
      if (!${opaqueOnly}) modes.push('none-rgba', 'none-rgb');
      if (kind === 'fixture') modes.push('original-png');
      const timing = Object.fromEntries(modes.map(mode => [mode, []])), encoded = {}, pngProfiles = Object.fromEntries(modes.map(mode => [mode, []]));
      for (let round = 0; round < ${rounds}; round++) for (let shift = 0; shift < modes.length; shift++) {
        const mode = modes[(round + shift) % modes.length], canvas = makeSource(kind, width, height, colorSpace, cpu);
        benchmarkMode = mode; lastBenchmarkDetail = null;
        globalThis.__shinobuColdStartWorkerPngRgba = mode === 'native-worker-rgba' || mode === 'native-rgb-rgba';
        const profileStart = profiles.length, startedAt = performance.now();
        // Each original-file control gets fresh Blob identity. Its encodeMs=0 is
        // explicit and is never compared as a total re-encoding speed gain.
        const blob = mode === 'original-png' ? new Blob([fixtureBlob], { type: 'image/png' }) : await encodeCanvasToPngInWorker(canvas);
        const encodeMs = performance.now() - startedAt, shown = await show(blob, width, height);
        const totalMs = performance.now() - startedAt;
        timing[mode].push({ encodeMs, ...shown.timing, totalMs, bytes: blob.size, worker: lastBenchmarkDetail });
        pngProfiles[mode].push(...profiles.slice(profileStart)); encoded[mode] = blob;
        // All pixel reads and PNG inspection are after the measured endpoint.
        equal(expected, imageRgba(shown.image, width, height, colorSpace), kind + ' ' + mode + ' native decoded RGBA');
        if (expectedDisplay) equal(expectedDisplay, imageRgba(shown.image, width, height, 'srgb'), kind + ' ' + mode + ' sRGB display');
        equal(sourcePixels, canvas.getContext('2d').getImageData(0, 0, width, height).data, kind + ' source unchanged');
        if (colorSpace === 'display-p3' && !mode.startsWith('native-worker') && lastBenchmarkDetail?.actual !== 'native-fallback') throw new Error('P3 must use native fallback');
        if (colorSpace === 'srgb' && mode.startsWith('none-') && lastBenchmarkDetail?.actual !== 'none-deflate') throw new Error('sRGB candidate did not actually run');
        release(shown); canvas.width = 0; canvas.height = 0;
      }
      const pngInfo = {};
      for (const mode of modes) {
        pngInfo[mode] = await inspect(encoded[mode]);
        if (mode.startsWith('none-') && colorSpace === 'srgb' && pngInfo[mode].filters[0] !== height) throw new Error('Candidate filter-none not applied');
      }
      const alphaValues = new Set(); for (let p = 3; p < expected.length; p += 4) alphaValues.add(expected[p]);
      if ((kind === 'alpha' || kind === 'debug') && alphaValues.size < 200) throw new Error('Alpha edge coverage insufficient');
      for (const mode of ['native-rgb-bitmap', 'native-rgb-rgba']) {
        const opaque = colorSpace === 'srgb' && alphaValues.size === 1 && alphaValues.has(255);
        const expectedActual = opaque ? 'native-rgb' : 'native-fallback';
        if (timing[mode].some(sample => sample.worker.actual !== expectedActual)) throw new Error('Opacity/P3 gate did not select expected path');
        if (opaque && pngInfo[mode].colorType !== 2) throw new Error('alpha:false target did not emit RGB PNG');
        if (!opaque && pngInfo[mode].colorType !== pngInfo['native-worker'].colorType) throw new Error('Fallback PNG format changed');
      }
      const medianMs = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(['encodeMs','decodeMs','rafMs','displayMs','totalMs']
        .map(key => [key, median(timing[mode].map(sample => sample[key]))]))]));
      checks.push({ kind, colorSpace, cpu, width, height, passed: true, alphaValues: alphaValues.size,
        timing, medianMs, pngInfo, profiles: pngProfiles, byteRatio: Object.fromEntries(modes.map(mode => [mode, encoded[mode].size / encoded['native-worker'].size])) });
    }
  }
  fixtureBitmap.close(); delete globalThis.__shinobuColdStartInitMark;
  return { userAgent: navigator.userAgent, rounds: ${rounds}, checks, originalFixture, failures: 0,
    timingIncludes: 'complete PNG Worker startup/snapshot/read/opacity scan/target draw/native PNG or CompressionStream/CRC/Blob delivery, BlobURL, single img.decode, RAF',
    caveat: 'Foreground native microbenchmark; pixel checks after timing; rotated mode order; original-png is decode-only. Not full extension cold-start evidence.' };
})()`;
new Function(workerCode); new Function(script);
if (process.argv.includes('--cpu-gate')) {
  let checks = 0;
  for (const mode of ['native-rgb-bitmap', 'native-rgb-rgba']) for (const kind of ['opaque', 'nonopaque', 'p3', 'unknown-format']) {
    const width = 4, height = 2, pixels = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < pixels.length; p += 4) { pixels[p] = p * 3; pixels[p + 1] = p * 5; pixels[p + 2] = p * 7; pixels[p + 3] = 255; }
    if (kind === 'nonopaque') pixels[7] = 127;
    const before = pixels.slice(), exports: { alpha: boolean; pixels: Uint8ClampedArray }[] = [];
    class FakeImageData {
      constructor(public data: Uint8ClampedArray) {}
    }
    class FakeCanvas {
      pixels: Uint8ClampedArray;
      alpha = true;
      constructor(public width: number, public height: number) { this.pixels = new Uint8ClampedArray(width * height * 4); }
      getContext(_type: string, settings: { colorSpace?: string; alpha?: boolean } = {}) {
        this.alpha = settings.alpha !== false;
        return { globalCompositeOperation: 'source-over',
          getContextAttributes: () => ({ colorSpace: settings.colorSpace ?? 'srgb', alpha: this.alpha,
            colorType: kind === 'unknown-format' ? undefined : 'unorm8' }),
          drawImage: (bitmap: { pixels: Uint8ClampedArray }) => this.pixels.set(bitmap.pixels),
          getImageData: () => ({ data: this.pixels.slice() }),
          putImageData: (image: FakeImageData) => this.pixels.set(image.data),
        };
      }
      async convertToBlob() {
        exports.push({ alpha: this.alpha, pixels: this.pixels.slice() });
        return new Blob([new Uint8Array(this.pixels)], { type: 'image/png' });
      }
    }
    const input = mode === 'native-rgb-rgba'
      ? { kind: 'rgba', pixels, width, height, profile: true, colorSpace: kind === 'p3' ? 'display-p3' : 'srgb' }
      : { kind: 'image-bitmap', bitmap: { width, height, pixels, close() {} }, profile: true, colorSpace: kind === 'p3' ? 'display-p3' : 'srgb' };
    type GateResult = { error?: string; blob: Blob; benchmarkDetail: { actual: string } };
    let resolve!: (result: GateResult) => void;
    const completed = new Promise<GateResult>(done => { resolve = done; });
    const scope = { location: { href: 'http://127.0.0.1/bench-png-worker.js?mode=' + mode },
      postMessage: resolve, onmessage: (_event: { data: typeof input }) => {} };
    new Function('self', 'OffscreenCanvas', 'ImageData', 'document', workerCode)(scope, FakeCanvas, FakeImageData, {});
    scope.onmessage({ data: input });
    const result = await completed, expected = kind === 'opaque' ? 'native-rgb' : 'native-fallback';
    if (result.error || result.benchmarkDetail.actual !== expected) throw new Error('Opaque Worker API selection failed: ' + mode + '/' + kind);
    if (exports.length !== 1 || exports[0].alpha !== (kind !== 'opaque')) throw new Error('Wrong export surface alpha');
    if (pixels.some((value, i) => value !== before[i]) || exports[0].pixels.some((value, i) => value !== before[i])) throw new Error('Opaque Worker changed pixel bytes');
    checks++;
  }
  console.log(JSON.stringify({ result: 'native opaque Worker branch CPU API gate passed', checks, maxPixels: 8,
    caveat: 'Fake Canvas selection/alpha guard only; real PNG/renderer/RGBA/headers require Root native gate' }));
} else if (process.argv.includes('--syntax-only')) {
  console.log(JSON.stringify({ result: 'generated PNG Worker + Window JavaScript parses', cases: fixtureOnly ? 2 : 18, rounds, opaqueOnly }));
} else {
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; worker-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'");
    if (request.url?.startsWith('/bench-png-worker.js')) { response.setHeader('Content-Type', 'application/javascript'); response.end(workerCode); }
    else if (request.url === '/fixture.png') { response.setHeader('Content-Type', 'image/png'); response.end(fixture); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Lossless PNG filter-none experiment</title>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark address unavailable');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.COLD_BUDGET_BROWSER || chromium.executablePath(), headless: false,
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`); await page.bringToFront();
    const result = await page.evaluate(script);
    const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
    if (out) writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
