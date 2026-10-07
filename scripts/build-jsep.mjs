import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Rebuild only the JS selection of the installed ORT. Its WASM and kernels stay
// unchanged. WebNN and WASM fallback remain; unused WebGL/native WebGPU do not.
export async function buildJsep(outputDirectory) {
  const ortRoot = join(dirname(fileURLToPath(import.meta.resolve('onnxruntime-web/all'))), '..');
  const ortVersion = JSON.parse(readFileSync(join(ortRoot, 'package.json'), 'utf8')).version;
  assert.equal(ortVersion, '1.27.0', 'Revalidate the cold-start runtime when upgrading ORT');
  const definitions = {
    DISABLE_WEBGL: true, DISABLE_JSEP: false, DISABLE_WEBGPU: true,
    DISABLE_WEBNN: false, DISABLE_WASM: false, DISABLE_WASM_PROXY: false,
    ENABLE_JSPI: false, ENABLE_BUNDLE_WASM_JS: false, IS_ESM: true,
    BUNDLE_FILENAME: 'ort.all.min.mjs',
  };
  const result = await build({
    entryPoints: [join(ortRoot, 'lib/index.ts')], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    treeShaking: true, write: false, metafile: true, legalComments: 'inline',
    conditions: ['onnxruntime-web-use-extern-wasm'], external: ['node:*'],
    define: {
      ...Object.fromEntries(Object.entries(definitions).map(([key, value]) =>
        [`BUILD_DEFS.${key}`, JSON.stringify(value)])),
      'BUILD_DEFS.ESM_IMPORT_META_URL': 'import.meta.url',
    },
  });
  const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll('\\', '/'));
  for (const file of ['/wasm/jsep/backend-webgpu.ts', '/wasm/jsep/backend-webnn.ts', '/wasm/wasm-core-impl.ts']) {
    assert(inputs.some(path => path.endsWith(file)), `Keep ${file}`);
  }
  assert(!inputs.some(path => path.includes('/onnxjs/') || path.includes('/wasm/webgpu/')));
  mkdirSync(outputDirectory, { recursive: true });
  const libraryPath = join(outputDirectory, 'ort-jsep.mjs');
  const bytes = result.outputFiles[0].contents;
  writeFileSync(libraryPath, bytes);
  return { libraryPath, ortVersion, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
