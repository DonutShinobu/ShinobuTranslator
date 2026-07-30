import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExtensionBuildTarget } from '../apps/extension/scripts/build-targets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDirFlagIndex = process.argv.indexOf('--out-dir');
const requestedOutDir = outDirFlagIndex >= 0 ? process.argv[outDirFlagIndex + 1] : undefined;
if (outDirFlagIndex >= 0 && !requestedOutDir) {
  throw new Error('--out-dir requires a path');
}
const outputDir = requestedOutDir
  ? resolve(process.cwd(), requestedOutDir)
  : resolveExtensionBuildTarget('chrome').absoluteOutDir;
const useStaticOrtRuntimeImports =
  !requestedOutDir
  || process.argv.includes('--static-ort-runtime-imports');
const staticOrtRuntimeSupport = useStaticOrtRuntimeImports
  ? await import(
    '../apps/extension/scripts/static-ort-runtime-imports.mjs'
  )
  : undefined;
function externalizeWorkerBuildModule(id) {
  return (
    staticOrtRuntimeSupport !== undefined
    && staticOrtRuntimeSupport.isPackagedOrtRuntimeModule(id)
  )
    || id.includes('onnxruntime-node')
    || id.includes('onnxNodeBridge')
    || id.includes('modelRegistryNode')
    || id.includes('ocrSharedNode');
}

// Separate build for the ONNX Worker. The production offscreen document loads
// this self-contained module directly from chrome-extension://. HTTP benchmark
// builds may still use the development-only Blob fallback.
await build({
  configFile: false,
  root: resolve(__dirname, '..'),
  publicDir: false,
  plugins: staticOrtRuntimeSupport === undefined
    ? []
    : [staticOrtRuntimeSupport.staticOrtRuntimeImportsPlugin()],
  build: {
    // The self-contained ONNX Runtime Worker is intentionally about 873 kB.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      external: externalizeWorkerBuildModule,
      input: resolve(__dirname, '../src/workers/onnx-worker.ts'),
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
