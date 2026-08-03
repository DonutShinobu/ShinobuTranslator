import { resolve } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin, UserConfig } from 'vite';
import { browserRuntimeBoundaryPlugin } from '../../scripts/vite-browser-runtime-boundary';
import { createExtensionManifest, type ExtensionTarget } from './manifest';

const extensionRoot = import.meta.dirname;
const repoRoot = resolve(extensionRoot, '../..');
const extensionPackage = JSON.parse(
  readFileSync(resolve(extensionRoot, 'package.json'), 'utf8'),
) as { version: string };

function extensionReleaseAssetsPlugin(
  target: ExtensionTarget,
  extensionDist: string,
): Plugin {
  return {
    name: 'extension-release-assets',
    apply: 'build',
    closeBundle() {
      writeFileSync(
        resolve(extensionDist, 'manifest.json'),
        `${JSON.stringify(createExtensionManifest(target, extensionPackage.version), null, 2)}\n`,
      );
      for (const webOnlyAsset of ['manifest.webmanifest', 'sw.js']) {
        rmSync(resolve(extensionDist, webOnlyAsset), { force: true });
      }
      const otherTargetArtifacts = target === 'chromium'
        ? ['background-firefox.html', 'background-firefox.js']
        : ['background-chromium.js', 'offscreen.html', 'offscreen.js'];
      for (const artifact of otherTargetArtifacts) {
        rmSync(resolve(extensionDist, artifact), { force: true });
      }
      for (const unusedOrtVariant of [
        'ort/ort-wasm-simd-threaded.asyncify.mjs',
        'ort/ort-wasm-simd-threaded.asyncify.wasm',
        'ort/ort-wasm-simd-threaded.mjs',
        'ort/ort-wasm-simd-threaded.wasm',
      ]) {
        rmSync(resolve(extensionDist, unusedOrtVariant), { force: true });
      }
    },
  };
}

function resolveExtensionTarget(mode: string): ExtensionTarget {
  if (mode === 'chromium' || mode === 'benchmark') return 'chromium';
  if (mode === 'firefox') return 'firefox';
  throw new Error('Extension target is required: use Vite mode "chromium" or "firefox".');
}

export default defineConfig(({ mode }): UserConfig => {
  const target = resolveExtensionTarget(mode);
  const extensionDist = resolve(extensionRoot, `dist-${target}`);

  if (mode === 'benchmark') {
    return {
      root: extensionRoot,
      envDir: repoRoot,
      publicDir: false,
      server: {
        fs: {
          allow: [repoRoot],
        },
      },
      build: {
        outDir: 'dist-chromium',
        emptyOutDir: false,
        rollupOptions: {
          input: {
            benchmark: resolve(extensionRoot, 'benchmark.html'),
          },
          output: {
            entryFileNames: 'benchmark.js',
            chunkFileNames: 'benchmark-chunks/[name].js',
            assetFileNames: 'benchmark-assets/[name][extname]',
          },
        },
      },
    };
  }

  return {
    root: extensionRoot,
    envDir: repoRoot,
    publicDir: resolve(repoRoot, 'public'),
    resolve: {
      conditions: ['onnxruntime-web-use-extern-wasm'],
    },
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    plugins: [
      browserRuntimeBoundaryPlugin({ apply: 'serve' }),
      react(),
      extensionReleaseAssetsPlugin(target, extensionDist),
    ],
    worker: {
      format: 'es',
      plugins: () => [
        browserRuntimeBoundaryPlugin({ apply: 'serve' }),
      ],
    },
    build: {
      outDir: `dist-${target}`,
      rollupOptions: {
        input: {
          popup: resolve(extensionRoot, 'popup.html'),
          'background-chromium': resolve(repoRoot, 'src/background/chromium.ts'),
          'background-firefox': resolve(extensionRoot, 'background-firefox.html'),
          offscreen: resolve(extensionRoot, 'offscreen.html'),
        },
        output: {
          onlyExplicitManualChunks: true,
          entryFileNames: (chunkInfo) => `${chunkInfo.name}.js`,
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name][extname]',
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/');
            if (normalized.endsWith('/packages/diagnostics/src/perfTrace.ts')) {
              return 'perfTrace';
            }
            if (normalized.endsWith('/src/shared/messages.ts')) {
              return 'messages';
            }
            if (normalized.endsWith('/packages/model-runtime/src/runtime/onnxWorkerBridge.ts')) {
              return 'onnxWorkerBridge';
            }
            if (normalized.endsWith('/src/shared/diagnosticLogClient.ts')) {
              return 'diagnosticLogClient';
            }
            if (normalized.endsWith('/src/offscreen/pipelineHost.ts')) {
              return 'pipelineHost';
            }
            return undefined;
          },
        },
      },
    },
  };
});
