import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Separate build for the ONNX Worker.
// Content scripts cannot create Workers pointing to chrome-extension:// URLs
// (same-origin policy), so we use a blob URL approach. This requires the
// Worker script to be self-contained (no external chunk imports), which is
// achieved by building it as a single-entry Rollup bundle.
await build({
  root: resolve(__dirname, '..'),
  build: {
    rollupOptions: {
      input: resolve(__dirname, '../src/workers/onnx-worker.ts'),
      output: {
        entryFileNames: 'onnxWorker.js',
        format: 'es',
        dir: resolve(__dirname, '../dist'),
      },
    },
    emptyOutDir: false,
    outDir: 'dist',
  },
});