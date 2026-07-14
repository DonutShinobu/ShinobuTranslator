import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Separate build for the ONNX Worker. The production offscreen document loads
// this self-contained module directly from chrome-extension://. HTTP benchmark
// builds may still use the development-only Blob fallback.
await build({
  root: resolve(__dirname, '..'),
  publicDir: false,
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
