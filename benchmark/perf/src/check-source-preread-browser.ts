import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Root runs native Canvas only. Independent source surfaces ensure an early
// getImageData cannot accidentally prewarm/migrate the baseline surface too.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
function functions(path: string, names?: string[]): string {
  const text = source(path), ast = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const nodes = ast.statements.filter(ts.isFunctionDeclaration).filter(node => !names || names.includes(node.name!.text));
  if (names && nodes.length !== names.length) throw new Error(`Function source missing: ${path}`);
  return nodes.map(node => node.getText(ast).replace(/^export\s+/, '')).join('\n');
}
const code = ts.transpileModule([
  functions('../../../packages/image-pipeline/src/pipeline/inpaint.ts'),
  functions('../../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms.ts', ['makeCanvas', 'readGrayImage', 'computeScaleFactor']),
  functions('../../../packages/image-pipeline/src/pipeline/maskRefinement/index.ts', ['prepareTextMaskGray']),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const fixture = fixturePath ? readFileSync(fixturePath)
  : readFileSync(new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const script = `(async () => {
  ${code}
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const isContextLostRuntimeError = () => false, toErrorMessage = error => String(error);
  const platform = { createCanvas(width, height) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
  }};
  const fixtureBytes = Uint8Array.from(atob(${JSON.stringify(fixture.toString('base64'))}), char => char.charCodeAt(0));
  const fixtureBitmap = await createImageBitmap(new Blob([fixtureBytes], { type: 'image/png' }));
  const repair = { data: Float32Array.from({ length: 512 * 512 * 3 }, (_, i) => i * 37 % 256 / 255),
    dims: [1, 3, 512, 512], type: 'float32' };
  function compareBytes(left, right) {
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength), b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    if (a.length !== b.length) return { result: 'different-length', left: a.length, right: b.length };
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { result: 'different-byte', offset: i, left: a[i], right: b[i] };
    return { result: 'bit-identical' };
  }
  function makeSource(bitmap, cpu) {
    const canvas = platform.createCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: cpu });
    ctx.drawImage(bitmap, 0, 0); return canvas;
  }
  function makeMask(width, height) {
    const canvas = platform.createCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 17; i++) ctx.fillRect((i * 197 + 5) % width, (i * 277 + 3) % height, width / 11, height / 13);
    return canvas;
  }
  async function execute(original, mask, prepared) {
    let feeds;
    const runtime = {
      async readModel() { return { input: [512], normalize: 'zero_to_one', outputNormalize: 'zero_to_one' }; },
      async getSession() { return { sessionId: 'native-canvas-only', provider: 'webgpu', inputNames: ['image', 'mask'] }; },
      async run(_session, input) { feeds = input; return { outputs: { repaired: repair } }; },
    };
    const result = await runInpaint(original, mask, platform, runtime, prepared);
    return { feeds, output: result.canvas,
      rgba: result.canvas.getContext('2d').getImageData(0, 0, original.width, original.height).data };
  }
  const checks = [];
  for (const kind of ['opaque', 'alpha', 'fixture']) {
    const width = kind === 'fixture' ? fixtureBitmap.width : 1031, height = kind === 'fixture' ? fixtureBitmap.height : 769;
    let bitmap = fixtureBitmap;
    if (kind !== 'fixture') {
      const seed = platform.createCanvas(width, height), ctx = seed.getContext('2d', { willReadFrequently: true });
      const image = ctx.createImageData(width, height);
      for (let i = 0, p = 0; i < width * height; i++, p += 4) {
        image.data[p] = i * 17 % 256; image.data[p + 1] = i * 53 % 256; image.data[p + 2] = i * 31 % 256;
        image.data[p + 3] = kind === 'alpha' ? i % 256 : 255;
      }
      ctx.putImageData(image, 0, 0);
      ctx.strokeStyle = 'rgba(223,17,91,0.37)'; ctx.lineWidth = 1.3; ctx.strokeRect(3.2, 7.4, 705.7, 593.3);
      bitmap = await createImageBitmap(seed); seed.width = 0; seed.height = 0;
    }
    for (const cpu of [false, true]) for (const direct of [false, true]) for (const mode of ['gray-only', 'gray-and-original']) {
      globalThis.__shinobuColdStartInpaintPixels = true;
      globalThis.__shinobuColdStartInpaintDirectPixels = direct;
      const baselineSource = makeSource(bitmap, cpu), candidateSource = makeSource(bitmap, cpu);
      const baselineMask = makeMask(width, height), candidateMask = makeMask(width, height);
      // This matches pipeline order: baseline gray is read before inpaint, but
      // its original 2D context is not read until the real inpaint helper does so.
      const baselineGray = prepareTextMaskGray(baselineSource, height, platform);
      const candidateGray = prepareTextMaskGray(candidateSource, height, platform);
      const prepared = mode === 'gray-and-original' ? prepareInpaintSource(candidateSource, platform) : undefined;
      const baseline = await execute(baselineSource, baselineMask), candidate = await execute(candidateSource, candidateMask, prepared);
      const comparisons = {
        gray: compareBytes(baselineGray.pixels, candidateGray.pixels),
        imageFeeds: compareBytes(baseline.feeds.image.data, candidate.feeds.image.data),
        maskFeeds: compareBytes(baseline.feeds.mask.data, candidate.feeds.mask.data),
        rgba: compareBytes(baseline.rgba, candidate.rgba),
        sourceNotMutated: compareBytes(
          baselineSource.getContext('2d').getImageData(0, 0, width, height).data,
          candidateSource.getContext('2d').getImageData(0, 0, width, height).data),
      };
      if (baseline.feeds.image.data.constructor.name !== 'Float32Array' || candidate.feeds.mask.data.constructor.name !== 'Float32Array') {
        throw new Error('Model feed precision changed');
      }
      checks.push({ kind, cpu, direct, mode, width, height, comparisons,
        passed: Object.values(comparisons).every(value => value.result === 'bit-identical') });
      for (const canvas of [baselineSource, candidateSource, baselineMask, candidateMask, baseline.output, candidate.output]) {
        canvas.width = 0; canvas.height = 0;
      }
    }
    if (bitmap !== fixtureBitmap) bitmap.close();
  }
  fixtureBitmap.close();
  return { userAgent: navigator.userAgent, checks, failures: checks.filter(check => !check.passed).length,
    caveat: 'Native Canvas + real pipeline preprocessing/composition, deterministic fake model; full extension detector/output SHA gate still required; no speed claim' };
})()`;
new Function(script); // Also permits a CPU syntax-only check while Root owns the GPU.
if (process.argv.includes('--syntax-only')) {
  console.log(JSON.stringify({ result: 'native-preread-generated-JS-parses', cases: 24, modelInput: 'float32-512' }));
} else {
  const browser = await chromium.launch({ executablePath: process.env.COLD_BUDGET_BROWSER || chromium.executablePath(), headless: false });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(script) as { failures: number };
    const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
    if (out) writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.failures) throw new Error(`Source preread native bit gate failed ${result.failures} cases`);
  } finally { await browser.close(); }
}
