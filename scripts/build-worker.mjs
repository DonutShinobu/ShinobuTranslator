import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildJsep } from './build-jsep.mjs';
import { chromiumColdStartPlugin, firefoxColdStartPlugin } from './cold-start-defaults.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerEntry = fileURLToPath(import.meta.resolve('@shinobu/model-runtime/worker'));
const outDirFlagIndex = process.argv.indexOf('--out-dir');
const requestedOutDir = outDirFlagIndex >= 0 ? process.argv[outDirFlagIndex + 1] : undefined;
if (!requestedOutDir || requestedOutDir.startsWith('--')) {
  throw new Error('--out-dir is required and must name a target-specific extension directory');
}
const outputDir = resolve(process.cwd(), requestedOutDir);
const root = resolve(__dirname, '..');
const chromium = requestedOutDir.endsWith('dist-chromium');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsep = await buildJsep(resolve(root, '.tmp/build-browser-jsep'));
const ortRoot = resolve(dirname(fileURLToPath(import.meta.resolve('onnxruntime-web/all'))), '..');
for (const file of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  assert.equal(hash(readFileSync(resolve(outputDir, 'ort', file))), hash(readFileSync(resolve(ortRoot, 'dist', file))),
    `Keep the paired ${file} unchanged`);
}
if (chromium) {
  const templates = JSON.parse(readFileSync(resolve(outputDir, 'webgpu-shader-templates.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(outputDir, 'models/models.json'), 'utf8'));
  const modelSignature = JSON.stringify(Object.fromEntries(Object.entries(manifest.models).map(([name, model]) =>
    [name, hash(readFileSync(resolve(outputDir, 'models', model.url.split('/').at(-1))))])));
  assert.equal(templates.ortVersion, jsep.ortVersion, 'Revalidate shader templates for the installed ORT');
  assert.equal(templates.modelSignature, modelSignature, 'Revalidate shader templates for the bundled models');
  mkdirSync(resolve(root, '.tmp/cold-start-main-integration'), { recursive: true });
  writeFileSync(resolve(root, '.tmp/cold-start-main-integration/build-metadata.json'), JSON.stringify({
    jsep, modelSignature, templateCount: templates.shaders.length,
    templateSha256: hash(readFileSync(resolve(outputDir, 'webgpu-shader-templates.json'))),
  }, null, 2));
}
function externalizeNodeOnlyAdapter(id) {
  return id.includes('onnxruntime-node')
    || id.includes('onnxNodeBridge')
    || id.includes('modelRegistryNode')
    || id.includes('ocrSharedNode');
}

// Separate build for the ONNX Worker. The production offscreen document loads
// this self-contained module directly from the extension origin. HTTP benchmark
// builds may still use the development-only Blob fallback.
await build({
  configFile: false,
  root: resolve(__dirname, '..'),
  publicDir: false,
  plugins: [chromium ? chromiumColdStartPlugin : firefoxColdStartPlugin],
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
    alias: [{ find: 'onnxruntime-web/all', replacement: jsep.libraryPath }],
  },
  build: {
    // Both browsers use the same JSEP-only JS, retaining WebGPU/WebNN/WASM.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      external: externalizeNodeOnlyAdapter,
      input: workerEntry,
      output: {
        entryFileNames: 'onnxWorker.js',
        format: 'es',
        dir: outputDir,
      },
    },
    emptyOutDir: false,
    outDir: outputDir,
  },
});
