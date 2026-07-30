import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserRuntimeBoundaryPlugin } from '../../scripts/vite-browser-runtime-boundary';

const modelManifest = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../packages/model-manifest/manifest.json'),
  'utf8',
)) as { assets: Array<{ path: string }> };

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [
    browserRuntimeBoundaryPlugin(),
    react(),
    {
      name: 'shinobu-pages-config',
      closeBundle() {
        for (const asset of modelManifest.assets) {
          rmSync(
            resolve(import.meta.dirname, 'dist', 'models', asset.path),
            { force: true },
          );
        }
        copyFileSync(
          resolve(import.meta.dirname, '_headers'),
          resolve(import.meta.dirname, 'dist', '_headers'),
        );
        for (const documentName of [
          'PRIVACY_POLICY.md',
          'THIRD_PARTY_DEPENDENCIES.json',
          'THIRD_PARTY_NOTICES.md',
          'WEB_PUBLIC_BETA_RELEASE_NOTES.md',
          'WEB_TROUBLESHOOTING.md',
        ]) {
          copyFileSync(
            resolve(import.meta.dirname, '../..', documentName),
            resolve(import.meta.dirname, 'dist', documentName),
          );
        }
      },
    },
  ],
  publicDir: '../../public',
  worker: {
    format: 'es',
    plugins: () => [
      browserRuntimeBoundaryPlugin(),
    ],
  },
  server: {
    port: 5174,
    headers: isolationHeaders,
  },
  preview: {
    port: 4174,
    headers: isolationHeaders,
  },
});
