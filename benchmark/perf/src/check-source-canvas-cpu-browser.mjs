import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Root owns native browser/GPU runs. Keep the failed experiment isolated:
// inject one guarded context selection into the otherwise real imageToCanvas.
const imageSource = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/image.ts', import.meta.url), 'utf8');
const imageAst = ts.createSourceFile('image.ts', imageSource, ts.ScriptTarget.ES2022, true);
const imageNode = imageAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'imageToCanvas');
const platformSource = readFileSync(new URL('../../../apps/extension/src/shared/browserPipelinePlatform.ts', import.meta.url), 'utf8');
const platformAst = ts.createSourceFile('browserPipelinePlatform.ts', platformSource, ts.ScriptTarget.ES2022, true);
const platformNode = platformAst.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
  .find(node => node.name.getText(platformAst) === 'browserPipelinePlatform');
const loadNode = platformNode?.initializer?.properties?.find(node => node.name?.getText(platformAst) === 'loadImage');
if (!imageNode || !loadNode || !ts.isMethodDeclaration(loadNode)) throw new Error('Real imageToCanvas/loadImage source missing');
const originalImageFunction = imageNode.getText(imageAst).replace(/^export\s+/, '');
const contextToken = 'const ctx = canvas.getContext("2d");';
if (originalImageFunction.split(contextToken).length !== 2) throw new Error('SourceCanvasCpu exact context token must occur once');
const candidateImageFunction = originalImageFunction.replace(contextToken,
  'const ctx = (globalThis as { __shinobuColdStartSourceCanvasCpu?: boolean }).__shinobuColdStartSourceCanvasCpu === true'
    + ' ? canvas.getContext("2d", { willReadFrequently: true }) : canvas.getContext("2d");');
const code = ts.transpileModule(candidateImageFunction + '\nfunction ' + loadNode.getText(platformAst), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const syntaxOnly = process.argv.includes('--syntax-only');
const fixtureArgument = process.argv.find(arg => arg.startsWith('--fixture='));
const fixture = syntaxOnly ? new Uint8Array() : readFileSync(fixtureArgument?.slice('--fixture='.length)
  ?? new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const script = `(async () => {
  ${code}
  const platform = { createCanvas(width, height) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
  }};
  const checks = [];
  function compare(left, right) {
    if (left.length !== right.length) return { equal: false, differentBytes: -1, reason: 'length' };
    let differentBytes = 0, firstDifference;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) {
      if (!differentBytes) firstDifference = { offset: i, baseline: left[i], candidate: right[i] };
      differentBytes++;
    }
    return { equal: differentBytes === 0, differentBytes, firstDifference };
  }
  async function inspect(blob, kind, sourceColorSpace) {
    const url = URL.createObjectURL(blob);
    let image;
    try { image = await loadImage(url); } finally { URL.revokeObjectURL(url); }
    const width = image.naturalWidth, height = image.naturalHeight;
    const scaled = maxSide => {
      const scale = Math.min(1, maxSide / Math.max(width, height));
      return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
    };
    for (const [mode, outWidth, outHeight] of [['source-1to1', width, height],
      ['panel1800', ...scaled(1800)], ['mask2048', ...scaled(2048)], ['inpaint512', 512, 512]]) {
      const sources = [false, true].map(cpu => {
        globalThis.__shinobuColdStartSourceCanvasCpu = cpu;
        const canvas = imageToCanvas(image, platform), attrs = canvas.getContext('2d').getContextAttributes();
        if (attrs.willReadFrequently !== cpu || attrs.colorSpace !== 'srgb' || attrs.colorType !== 'unorm8' || !attrs.alpha) {
          throw new Error('Original source context settings/flag mismatch');
        }
        return canvas;
      });
      let outputs;
      if (mode === 'source-1to1') {
        outputs = sources.map(canvas => canvas.getContext('2d').getImageData(0, 0, width, height).data);
      } else {
        // Fresh sources for every size. Consume/scale each before reading it:
        // a baseline getImageData before draw can migrate the GPU source to CPU.
        const targets = sources.map(source => {
          const canvas = platform.createCanvas(outWidth, outHeight), ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(source, 0, 0, outWidth, outHeight); return canvas;
        });
        outputs = targets.map(canvas => canvas.getContext('2d').getImageData(0, 0, outWidth, outHeight).data);
        for (const canvas of targets) { canvas.width = 0; canvas.height = 0; }
      }
      const comparison = compare(outputs[0], outputs[1]);
      checks.push({ kind, sourceColorSpace, mode, width, height, outWidth, outHeight, comparison });
      for (const canvas of sources) { canvas.width = 0; canvas.height = 0; }
    }
  }
  for (const colorSpace of ['srgb', 'display-p3']) for (const kind of ['opaque', '256alpha', 'fulltransparent']) {
    const width = 2053, height = 257, seed = platform.createCanvas(width, height);
    const ctx = seed.getContext('2d', { willReadFrequently: true, colorSpace });
    if (ctx.getContextAttributes().colorSpace !== colorSpace) throw new Error('Native color space unsupported');
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = (x * 37 + y * 17) & 255; data[p + 1] = (x * 11 + y * 53) & 255;
      data[p + 2] = (x * 71 + y * 29) & 255;
      data[p + 3] = kind === 'opaque' ? 255 : kind === 'fulltransparent' ? 0 : (x + y) & 255;
    }
    ctx.putImageData(new ImageData(data, width, height, { colorSpace }), 0, 0);
    const blob = await new Promise((resolve, reject) => seed.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
    seed.width = 0; seed.height = 0;
    await inspect(blob, kind + '-PNG', colorSpace);
  }
  const fixtureBytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(fixture).toString('base64'))}), char => char.charCodeAt(0));
  await inspect(new Blob([fixtureBytes], { type: 'image/png' }), 'fixture-PNG', 'fixture-metadata');
  delete globalThis.__shinobuColdStartSourceCanvasCpu;
  return { userAgent: navigator.userAgent, checks, failures: checks.filter(check => !check.comparison.equal).length,
    caveat: 'Real PNG loadImage and source copy/resampling bit gate; context attributes are hints, not a GPU backend measurement. Full extension two-image raw detector/OCR/inpaint/final PNG gates still required; no speed claim.' };
})()`;
new Function(script);
if (syntaxOnly) {
  console.log(JSON.stringify({ result: 'source-canvas-native-generated-JS-parses', expectedChecks: 28 }));
} else {
  const executableArgument = process.argv.find(arg => arg.startsWith('--browser-executable='));
  const browser = await chromium.launch({ executablePath: executableArgument?.slice('--browser-executable='.length)
    ?? process.env.COLD_BUDGET_BROWSER ?? chromium.executablePath(), headless: false });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(script);
    const out = process.argv.find(arg => arg.startsWith('--out='));
    if (out) writeFileSync(out.slice('--out='.length), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.failures) throw new Error('SourceCanvasCpu native bit gate failed ' + result.failures + ' cases; stop candidate');
  } finally { await browser.close(); }
}
