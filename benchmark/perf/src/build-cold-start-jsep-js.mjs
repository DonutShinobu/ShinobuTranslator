// Build an isolated same-version JSEP JS candidate. Existing WASM, models and
// Session options are untouched; the experiment runner decides whether to use it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { patchJsepUploadWriteBuffer } from './cold-jsep-upload-write-patch.mjs';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, '.tmp/cold-budget-jsepjs');
const ortRoot = resolve(dirname(fileURLToPath(import.meta.resolve('onnxruntime-web/all'))), '..');
const installedVersion = JSON.parse(readFileSync(join(ortRoot, 'package.json'), 'utf8')).version;
assert.equal(installedVersion, '1.27.0', 'This candidate is tied to the examined 1.27.0 JSEP source');
mkdirSync(out, { recursive: true });
const definitions = {
  DISABLE_WEBGL: true,
  DISABLE_JSEP: false,
  DISABLE_WEBGPU: true, // Keep JSEP; do not switch to the native WebGPU EP.
  DISABLE_WEBNN: false,
  DISABLE_WASM: false,
  DISABLE_WASM_PROXY: false,
  ENABLE_JSPI: false,
  ENABLE_BUNDLE_WASM_JS: false,
  IS_ESM: true,
  BUNDLE_FILENAME: 'ort.all.min.mjs',
};
const define = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [`BUILD_DEFS.${key}`, JSON.stringify(value)]));
define['BUILD_DEFS.ESM_IMPORT_META_URL'] = 'import.meta.url';
const sourcePatches = [];
const ortBundle = await esbuild({
  entryPoints: [join(ortRoot, 'lib/index.ts')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, treeShaking: true, write: false, metafile: true, define,
  conditions: ['onnxruntime-web-use-extern-wasm'],
  external: ['node:*'], // Keep existing unreachable Node adapters outside the browser bundle.
  legalComments: 'inline',
  plugins: [{ name: 'cold-start-jsep-upload-write', setup(context) {
    context.onLoad({ filter: /[\\/]wasm[\\/]jsep[\\/]webgpu[\\/]gpu-data-manager\.ts$/ }, args => {
      const patched = patchJsepUploadWriteBuffer(readFileSync(args.path, 'utf8'));
      sourcePatches.push(patched.metadata);
      return { contents: patched.contents, loader: 'ts', resolveDir: dirname(args.path) };
    });
  } }],
});
assert.equal(sourcePatches.length, 1, 'Only the examined JSEP GPUDataManager is patched');
const ortInputs = Object.keys(ortBundle.metafile.inputs).map(x => x.replaceAll('\\', '/'));
assert(ortInputs.some(x => x.endsWith('/wasm/jsep/backend-webgpu.ts')), 'JSEP WebGPU kernels must remain included');
assert(ortInputs.some(x => x.endsWith('/wasm/jsep/backend-webnn.ts')), 'WebNN fallback must remain included');
assert(ortInputs.some(x => x.endsWith('/wasm/wasm-core-impl.ts')), 'WASM fallback must remain included');
assert(!ortInputs.some(x => x.includes('/onnxjs/')), 'Unused WebGL code must be excluded');
assert(!ortInputs.some(x => x.includes('/wasm/webgpu/')), 'Native WebGPU EP must not replace JSEP');
const ortPath = join(out, 'ort-jsep-no-webgl.mjs');
writeFileSync(ortPath, ortBundle.outputFiles[0].contents);
const candidateApi = await import(pathToFileURL(ortPath).href);
const installedApi = await import('onnxruntime-web/all');
for (const name of ['env', 'Tensor', 'InferenceSession']) assert.equal(typeof candidateApi[name], typeof installedApi[name], `Preserve the ${name} API`);
assert.equal(candidateApi.env.versions.web, installedVersion);
const tensorData = Float32Array.of(-0, 1.25, -9.5);
const candidateTensor = new candidateApi.Tensor('float32', tensorData, [1, 3]);
const installedTensor = new installedApi.Tensor('float32', tensorData, [1, 3]);
assert.equal(candidateTensor.type, installedTensor.type);
assert.deepEqual(candidateTensor.dims, installedTensor.dims);
assert.equal(candidateTensor.data, tensorData, 'Tensor precision and input ownership stay unchanged');

// Match scripts/build-worker.mjs; the single alias removes unused ORT WebGL code.
const workerEntry = fileURLToPath(import.meta.resolve('@shinobu/model-runtime/worker'));
await viteBuild({
  configFile: false, root, publicDir: false,
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'],
    alias: [{ find: 'onnxruntime-web/all', replacement: ortPath }] },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      external: (id) => ['onnxruntime-node', 'onnxNodeBridge', 'modelRegistryNode', 'ocrSharedNode'].some(name => id.includes(name)),
      input: workerEntry,
      output: { entryFileNames: 'onnxWorker.js', format: 'es', dir: out },
    },
    emptyOutDir: false, outDir: out,
  },
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packaged = readFileSync(join(ortRoot, 'dist/ort.all.min.mjs'));
const library = readFileSync(ortPath);
const worker = readFileSync(join(out, 'onnxWorker.js'));
assert(!worker.includes('BUILD_DEFS.'), 'Every build definition must be resolved');
const baselinePath = join(root, 'apps/extension/dist-chromium/onnxWorker.js');
const baseline = readFileSync(baselinePath);
const metadata = {
  ortVersion: installedVersion, definitions,
  sourcePatches,
  packagedOrtJs: { bytes: packaged.length, sha256: hash(packaged) },
  candidateOrtJs: { bytes: library.length, sha256: hash(library) },
  baselineWorker: { bytes: baseline.length, sha256: hash(baseline) },
  candidateWorker: { path: join(out, 'onnxWorker.js'), bytes: worker.length, sha256: hash(worker) },
  pairedWasmResources: Object.fromEntries(['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'].map(name => {
    const installed = readFileSync(join(ortRoot, 'dist', name));
    const deployed = readFileSync(join(root, 'apps/extension/dist-chromium/ort', name));
    assert.equal(hash(installed), hash(deployed), `Existing ${name} must match the same installed package`);
    return [name, { bytes: installed.length, sha256: hash(installed) }];
  })),
  // A rebuilt baseline must use these same project sources before browser A/B.
  sourceHashes: Object.fromEntries([workerEntry, ...ortInputs.map(path => resolve(root, path))]
    .map(path => [relative(root, path).replaceAll('\\', '/'), hash(readFileSync(path))])),
  performanceMeasured: false,
};
writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ ortVersion: installedVersion,
  ortJsBytes: [packaged.length, library.length], workerBytes: [baseline.length, worker.length],
  candidateWorker: join(out, 'onnxWorker.js'), metadata: join(out, 'metadata.json'), performanceMeasured: false }));
