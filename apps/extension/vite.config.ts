import { resolve } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin, UserConfig } from 'vite';
import { browserRuntimeBoundaryPlugin } from '../../scripts/vite-browser-runtime-boundary';
import {
  classicContentScriptAdapter,
} from './build/classicContentScriptAdapter';
import { resolveExtensionBuildTarget } from './scripts/build-targets.mjs';

const REPO = 'DonutShinobu/ShinobuTranslator';
const extensionRoot = import.meta.dirname;
const repoRoot = resolve(extensionRoot, '../..');

function externalizeNodeOnlyModule(id: string): boolean {
  if (id === 'module' || id === 'worker_threads') return true;
  if (id.includes('onnxruntime-node')) return true;
  if (id.includes('onnxNodeBridge')) return true;
  if (id.includes('modelRegistryNode')) return true;
  if (id.includes('nodePlatform')) return true;
  if (id.includes('ocrSharedNode')) return true;
  return false;
}

// Replaces model URLs in a target's models/models.json with GitHub Release URLs
// when MODEL_RELEASE_TAG is set (e.g. MODEL_RELEASE_TAG=models-v0.4.0).
function modelReleaseUrlPlugin(outputDirectory: string): Plugin {
  return {
    name: 'model-release-url',
    apply: 'build',
    closeBundle() {
      rmSync(resolve(outputDirectory, 'models/ocr.onnx'), { force: true });
      const tag = process.env.MODEL_RELEASE_TAG;
      if (!tag) return;
      const manifestPath = resolve(outputDirectory, 'models/models.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const baseUrl = `https://github.com/${REPO}/releases/download/${tag}`;
      // Manifest paths like "/models/detector.onnx" become "detector.onnx" in Release assets
      // (gh release upload uses bare filenames, no directory structure)
      const toReleaseUrl = (path: string) =>
        `${baseUrl}/${path.replace(/^\/models\//, '')}`;
      for (const model of Object.values(manifest.models) as Array<{ url?: string; dictUrl?: string }>) {
        if (model.url && model.url.startsWith('/')) {
          model.url = toReleaseUrl(model.url);
        }
        if (model.dictUrl && model.dictUrl.startsWith('/')) {
          model.dictUrl = toReleaseUrl(model.dictUrl);
        }
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

function extensionReleaseAssetsPlugin(outputDirectory: string): Plugin {
  return {
    name: 'extension-release-assets',
    apply: 'build',
    closeBundle() {
      for (const webOnlyAsset of ['manifest.webmanifest', 'sw.js']) {
        rmSync(resolve(outputDirectory, webOnlyAsset), { force: true });
      }
    },
  };
}

export default defineConfig(({ command, mode }): UserConfig => {
  const benchmarkEntryBuild = mode === 'benchmark-entry';
  const target = resolveExtensionBuildTarget(
    command === 'serve'
      ? 'chrome'
      : benchmarkEntryBuild
        ? 'benchmark'
        : mode,
  );
  if (benchmarkEntryBuild) {
    return {
      root: extensionRoot,
      envDir: repoRoot,
      publicDir: false,
      define: {
        process: 'undefined',
      },
      build: {
        outDir: target.absoluteOutDir,
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
          external: externalizeNodeOnlyModule,
        },
      },
    };
  }
  const input: Record<string, string> = {
    popup: resolve(extensionRoot, 'popup.html'),
    background: resolve(extensionRoot, 'src/background.ts'),
    content: resolve(extensionRoot, 'src/content.ts'),
    'ort/ort-wasm-simd-threaded': resolve(
      repoRoot,
      'public/ort/ort-wasm-simd-threaded.mjs',
    ),
    'ort/ort-wasm-simd-threaded.asyncify': resolve(
      repoRoot,
      'public/ort/ort-wasm-simd-threaded.asyncify.mjs',
    ),
    'ort/ort-wasm-simd-threaded.jsep': resolve(
      repoRoot,
      'public/ort/ort-wasm-simd-threaded.jsep.mjs',
    ),
  };
  if (target.browser === 'chrome') {
    input.offscreen = resolve(extensionRoot, 'offscreen.html');
  } else {
    input['chunks/diagnosticLogClient'] = fileURLToPath(
      import.meta.resolve(
        '@shinobu/browser-runtime/diagnostic-log-client',
      ),
    );
  }

  return {
    root: extensionRoot,
    envDir: repoRoot,
    publicDir: resolve(repoRoot, 'public'),
    define: {
      process: 'undefined',
      'globalThis.process': 'undefined',
    },
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    plugins: [
      browserRuntimeBoundaryPlugin({ apply: 'serve' }),
      react(),
      classicContentScriptAdapter(),
      extensionReleaseAssetsPlugin(target.absoluteOutDir),
      modelReleaseUrlPlugin(target.absoluteOutDir),
    ],
    worker: {
      format: 'es',
      plugins: () => [
        browserRuntimeBoundaryPlugin({ apply: 'serve' }),
      ],
    },
    build: {
      outDir: target.absoluteOutDir,
      emptyOutDir: true,
      rollupOptions: {
        input,
        output: {
          entryFileNames: (chunkInfo) =>
            chunkInfo.name.startsWith('ort/')
              ? `${chunkInfo.name}.mjs`
              : `${chunkInfo.name}.js`,
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name][extname]',
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/');
            if (
              normalized.endsWith(
                '/packages/browser-runtime/src/diagnosticLog.ts',
              )
            ) {
              return 'diagnosticPrimitives';
            }
            if (normalized.endsWith('/src/shared/messages.ts')) {
              return 'messages';
            }
            if (normalized.endsWith('/src/shared/localPipelineProtocol.ts')) {
              return 'localPipelineProtocol';
            }
            if (normalized.endsWith('/apps/extension/src/capabilities/chromeAdapter.ts')) {
              return 'chromeAdapter';
            }
            if (normalized.endsWith('/src/shared/perfTrace.ts')) {
              return 'perfTrace';
            }
            if (normalized.endsWith('/src/runtime/onnxWorkerBridge.ts')) {
              return 'onnxWorkerBridge';
            }
            return undefined;
          },
        },
        // Node-only modules must be externalized for the browser build.
        // These modules are loaded via dynamic import() guarded by isNode,
        // but Vite/Rollup still resolves and bundles them as reachable chunks.
        // Externalizing prevents them from appearing in the browser extension
        // and avoids __vite-browser-external.js shims that can break Chrome extensions.
        external: externalizeNodeOnlyModule,
      },
    },
  };
});
