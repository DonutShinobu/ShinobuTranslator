import { resolve } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin, UserConfig } from 'vite';
import { browserRuntimeBoundaryPlugin } from '../../scripts/vite-browser-runtime-boundary';
import { resolveExtensionBuildTarget } from './scripts/build-targets.mjs';

const REPO = 'DonutShinobu/ShinobuTranslator';
const extensionRoot = import.meta.dirname;
const repoRoot = resolve(extensionRoot, '../..');

function externalizeNodeOnlyModule(id: string): boolean {
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

function toSafeIdentifier(identifier: string): string {
  return identifier.replace(/\$/g, '\\u0024');
}

function parseNamedImportBindings(bindings: string): Array<{ imported: string; local: string }> {
  return bindings.split(',').map((binding) => {
    const trimmed = binding.trim();
    const aliasMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/);
    if (aliasMatch) {
      return {
        imported: aliasMatch[1],
        local: aliasMatch[2],
      };
    }
    return {
      imported: trimmed,
      local: trimmed,
    };
  });
}

function buildNamespaceAssignments(namespace: string, bindings: string): string {
  return parseNamedImportBindings(bindings)
    .map(({ imported, local }) => `const ${toSafeIdentifier(local)}=${namespace}[${JSON.stringify(imported)}];`)
    .join('');
}

// Browser extension content scripts are classic scripts (no top-level import/export)
// in both Chrome and Firefox. This plugin bridges Vite's ES module output to that
// WebExtensions execution model:
// 1. Replaces import.meta.url with the cross-browser chrome.runtime.getURL namespace
// 2. Resolves dynamic imports through chrome.runtime.getURL
// 3. Strips exports from content.js and sets up window.__shinobu_shared for chunk access
// 4. Replaces chunk imports from the parent content bundle with window.__shinobu_shared lookups
function browserClassicContentScriptPlugin(): Plugin {
  return {
    name: 'browser-classic-content-script',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // Phase 1: Process content.js — strip exports, set up global bridge
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || fileName !== 'content.js') continue;

        chunk.code = chunk.code.replace(
          /\bimport\.meta\.url\b/g,
          '(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("content.js") : self.location.href)',
        );

        chunk.code = chunk.code.replace(
          /\bimport\(\s*"\.\/([^"]+)"\s*\)/g,
          'import(chrome.runtime.getURL("$1"))',
        );

        // Extract export mapping before stripping: export{Var1 as Name1, Var2 as Name2, ...}
        const exportMatch = chunk.code.match(/export\s*\{([^}]+)\}\s*;\s*$/);
        if (exportMatch) {
          const pairs = parseNamedImportBindings(exportMatch[1])
            .map(({ imported, local }) => `${JSON.stringify(local)}:${toSafeIdentifier(imported)}`);
          // Inject global bridge BEFORE stripping exports, so variables are still in scope
          chunk.code = chunk.code.replace(
            /export\s*\{[^}]+\}\s*;\s*$/,
            () => `window.__shinobu_shared={${pairs.join(',')}};`,
          );
        }

        // Convert static imports from chunks into dynamic imports via chrome.runtime.getURL.
        // Must run after export handling since IIFE wrapping changes the string end.
        const staticImportRe = /import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+)"\s*;?/g;
        const staticImports: Array<{ full: string; bindings: string; path: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = staticImportRe.exec(chunk.code)) !== null) {
          staticImports.push({ full: m[0], bindings: m[1], path: m[2] });
        }
        if (staticImports.length > 0) {
          staticImports.forEach((si, index) => {
            const namespace = `__shinobu_static_import_${index}`;
            chunk.code = chunk.code.replace(
              si.full,
              () => `const ${namespace}=await import(chrome.runtime.getURL("${si.path}"));${buildNamespaceAssignments(namespace, si.bindings)}`,
            );
          });
          chunk.code = `(async()=>{${chunk.code}})();`;
        }
      }

      // Phase 2: Replace chunk imports from the parent content bundle with global lookups
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !fileName.startsWith('chunks/')) continue;

        // Replace a named import from the parent content bundle.
        // With:    const {g: ft, a: J, ...} = window.__shinobu_shared;
        // Note: import uses "as" for renaming, destructuring uses ":"
        chunk.code = chunk.code.replace(
          /import\s*\{([^}]+)\}\s*from\s*"(\.\.\/content\.js|\.\/content\.js)"\s*;?/,
          (_match: string, imports: string) => {
            const namespace = '__shinobu_shared_import';
            return `const ${namespace}=window.__shinobu_shared;${buildNamespaceAssignments(namespace, imports)}`;
          },
        );

        // Also replace any import.meta.url in chunks
        chunk.code = chunk.code.replace(
          /\bimport\.meta\.url\b/g,
          `(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL("${fileName}") : self.location.href)`,
        );
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
    background: resolve(repoRoot, 'src/background/index.ts'),
    content: resolve(repoRoot, 'src/content/index.ts'),
  };
  if (target.browser === 'chrome') {
    input.offscreen = resolve(extensionRoot, 'offscreen.html');
  }

  return {
    root: extensionRoot,
    envDir: repoRoot,
    publicDir: resolve(repoRoot, 'public'),
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
    plugins: [
      browserRuntimeBoundaryPlugin({ apply: 'serve' }),
      react(),
      browserClassicContentScriptPlugin(),
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
          entryFileNames: (chunkInfo) => `${chunkInfo.name}.js`,
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name][extname]',
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/');
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
