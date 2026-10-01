// Native Canvas quality gate only. Run serially with other browser/GPU checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');
const fontBlobUrl = process.argv.includes('--font-blob-url');
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/extension/dist-chromium/manifest.json'), 'utf8'));
const pageCsp: string = manifest.content_security_policy.extension_pages;
const fonts = new Map(['SourceHanSansCN-VF.ttf.woff2', 'SourceHanSansTW-VF.ttf.woff2']
  .map(name => [`/fonts/${name}`, readFileSync(resolve(root, 'apps/extension/dist-chromium/fonts', name))]));
let browserBundle = '';
const server = createServer((request, response) => {
  const font = fonts.get(request.url ?? '');
  if (font) response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(font);
  else if (request.url === '/font-quality.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(browserBundle);
  else response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': pageCsp })
    .end('<!doctype html><title>Font quality gate</title>');
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const bundle = await build({
  stdin: { resolveDir: root, sourcefile: 'font-quality-entry.ts', loader: 'ts', contents: `
    import { registerTypesetFonts, resolveTypesetFontFamily, formatTypesetFont } from './packages/image-pipeline/src/pipeline/typeset/fontRuntime';
    import { drawTypeset } from './packages/image-pipeline/src/pipeline/typeset/drawTypeset';
    import { browserPipelinePlatform as platform } from './apps/extension/src/shared/browserPipelinePlatform';
    export async function run(selected, targetLang, debug, fontBlobUrl) {
      const records = [];
      globalThis.__shinobuColdStartFontBlobUrl = fontBlobUrl;
      globalThis.__shinobuColdStartInitMark = record => records.push(record);
      registerTypesetFonts(platform, path => location.origin+'/'+path, selected && !debug ? targetLang : undefined);
      await platform.waitForFonts();
      const texts = ['简体繁體「你好」——！？。〈测试〉龍龜臺', '日本語かなカナ、句読点。『縦書き』１２３', 'ABC 123 …“”‘’（），。：；！？％ / + -', '𠮷𡃁㐀🧪éΩ'];
      const canvas = platform.createCanvas(820, 760); const ctx=canvas.getContext('2d');
      ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      const regions = texts.flatMap((text, i)=>[
        { id:'h'+i, box:{x:20,y:20+i*80,width:780,height:65}, direction:'h', sourceText:text, translatedText:text, originalLineCount:1, fontSize:30, fgColor:[0,0,0], bgColor:[255,255,255] },
        { id:'v'+i, box:{x:40+i*190,y:355,width:150,height:380}, direction:'v', sourceText:text, translatedText:text, originalLineCount:1, fontSize:30, fgColor:[0,0,0], bgColor:[255,255,255] },
      ]);
      const result=await drawTypeset(canvas, regions, targetLang, {debugMode:debug, collectDebugLog:debug}, platform);
      const pixels=result.canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels.buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');
      ctx.font=formatTypesetFont(32,resolveTypesetFontFamily(targetLang));
      const metrics=texts.map(text=>{const m=ctx.measureText(text);return [m.width,m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent,m.fontBoundingBoxAscent,m.fontBoundingBoxDescent]});
      return {sha256,metrics,families:[...document.fonts].map(face=>face.family).sort(),fallbackChain:resolveTypesetFontFamily(targetLang),
        fontBlobUrlLoads:records.filter(record=>record.phase==='font.blob-url-loaded').length,
        fontBlobUrlFallbacks:records.filter(record=>record.phase==='font.blob-url-fallback').length};
    }
    globalThis.ShinobuFontQuality = { run };
  ` },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
});
browserBundle = bundle.outputFiles![0]!.text;
const executablePath = process.argv.find(value => value.startsWith('--browser-executable='))?.slice('--browser-executable='.length)
  ?? chromium.executablePath();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const checks: unknown[] = [];
  for (const targetLang of ['zh-CN', 'zh-CHT', 'ja']) for (const debug of [false, true]) {
    const outputs = [];
    for (const variant of [
      { selected: fontBlobUrl, blobUrl: false },
      { selected: true, blobUrl: fontBlobUrl },
    ]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}`);
        await page.addScriptTag({ url: `http://127.0.0.1:${port}/font-quality.js`, type: 'module' });
        outputs.push(await page.evaluate(async ({ selected, blobUrl, targetLang, debug }) => {
          const quality = globalThis as typeof globalThis & {
            ShinobuFontQuality: { run(selected: boolean, language: string, debug: boolean, blobUrl: boolean): Promise<{
              sha256: string; metrics: number[][]; families: string[]; fallbackChain: string;
              fontBlobUrlLoads: number; fontBlobUrlFallbacks: number;
            }> };
          };
          return quality.ShinobuFontQuality.run(selected, targetLang, debug, blobUrl);
        }, { ...variant, targetLang, debug }));
      } finally { await context.close(); }
    }
    assert.equal(outputs[0]!.sha256, outputs[1]!.sha256, `${targetLang}/${debug}: horizontal+vertical Canvas pixels`);
    assert.deepEqual(outputs[0]!.metrics, outputs[1]!.metrics, `${targetLang}/${debug}: original font and fallback metrics`);
    assert.equal(outputs[0]!.fallbackChain, outputs[1]!.fallbackChain);
    assert.equal(outputs[1]!.families.length, debug ? 2 : 1);
    assert.equal(outputs[1]!.fontBlobUrlLoads, fontBlobUrl ? (debug ? 2 : 1) : 0, 'actual Blob FontFace path');
    assert.equal(outputs[1]!.fontBlobUrlFallbacks, 0, 'quality gate must exercise the candidate without binary fallback');
    checks.push({ targetLang, debug, rgbaSha256: outputs[1]!.sha256, families: outputs[1]!.families,
      fontBlobUrlLoads: outputs[1]!.fontBlobUrlLoads, result: 'bit-identical' });
  }
  console.log(JSON.stringify({ browserVersion: browser.version(), fontBlobUrl, pageCsp, checks }, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
}
