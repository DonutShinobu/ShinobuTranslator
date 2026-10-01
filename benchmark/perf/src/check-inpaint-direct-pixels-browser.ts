import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Test the actual private pixel functions in native Canvas, without loading models.
const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/inpaint.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source.slice(source.indexOf('function inpaintPixelFastPath'),
  source.indexOf('function isLikelyInvalidInpaintResult')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^export\s+/gm, '');
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: false });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(`(() => {
    ${code}
    const platform = { createCanvas(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height; return canvas;
    } };
    function equal(a, b, label) {
      if (a.length !== b.length) throw new Error(label + ': length');
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
        throw new Error(label + ': byte ' + i + ' ' + a[i] + ' != ' + b[i]);
      }
    }
    const checks = [];
    for (const cpuCanvas of [false, true]) for (const opaque of [false, true]) {
      const width = 127, height = 83, area = width * height;
      function makeSource(mask) {
        const canvas = platform.createCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: cpuCanvas });
        const image = ctx.createImageData(width, height);
        for (let i = 0, p = 0; i < area; i++, p += 4) {
          image.data[p] = mask ? [0, 126, 127, 128, 255][i % 5] : i * 17 % 256;
          image.data[p + 1] = mask ? image.data[p] : i * 53 % 256;
          image.data[p + 2] = mask ? image.data[p] : i * 31 % 256;
          image.data[p + 3] = opaque ? 255 : i * 37 % 256;
        }
        ctx.putImageData(image, 0, 0);
        ctx.fillStyle = 'rgba(37,119,231,0.23)'; ctx.fillRect(3, 7, 51, 47);
        return canvas;
      }
      const sourceCanvas = makeSource(false), maskCanvas = makeSource(true);
      const decoded = new Uint8ClampedArray(512 * 512 * 4);
      for (let p = 0; p < decoded.length; p++) decoded[p] = p % 4 === 3 ? 255 : p * 19 % 256;
      globalThis.__shinobuColdStartInpaintPixels = false;
      const resized = resizeRgba(decoded, 512, 512, width, height, platform);
      for (const fast of [false, true]) {
        globalThis.__shinobuColdStartInpaintPixels = fast;
        globalThis.__shinobuColdStartInpaintDirectPixels = false;
        const original = readCanvasRgba(sourceCanvas, width, height, platform);
        const mask = readMaskBinary(maskCanvas, width, height, platform);
        const baseline = composeInpaintResult(original, resized, mask, width, height, platform)
          .getContext('2d').getImageData(0, 0, width, height).data;
        globalThis.__shinobuColdStartInpaintDirectPixels = true;
        const ownedCopy = readDirectCanvasImageData(sourceCanvas, width, height);
        equal(original, ownedCopy.data, 'original read');
        const before = sourceCanvas.getContext('2d').getImageData(0, 0, width, height).data;
        const directMask = readMaskBinary(maskCanvas, width, height, platform);
        equal(mask, directMask, 'mask read');
        const direct = composeInpaintResult(ownedCopy.data, resized, directMask, width, height,
          platform, ownedCopy).getContext('2d').getImageData(0, 0, width, height).data;
        equal(baseline, direct, 'composite');
        equal(before, sourceCanvas.getContext('2d').getImageData(0, 0, width, height).data, 'source not mutated');
        checks.push({ cpuCanvas, opaque, fast, result: 'bit-identical' });
      }
    }
    return { checks, userAgent: navigator.userAgent };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
