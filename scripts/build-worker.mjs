import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDirFlagIndex = process.argv.indexOf('--out-dir');
const requestedOutDir = outDirFlagIndex >= 0 ? process.argv[outDirFlagIndex + 1] : undefined;
if (!requestedOutDir || requestedOutDir.startsWith('--')) {
  throw new Error('--out-dir is required and must name a target-specific extension directory');
}
const outputDir = resolve(process.cwd(), requestedOutDir);
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
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  build: {
    // The self-contained ONNX Runtime Worker is intentionally about 873 kB.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      external: externalizeNodeOnlyAdapter,
      input: resolve(__dirname, '../packages/model-runtime/src/workers/onnx-worker.ts'),
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
