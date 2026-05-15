import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const REPO = 'DonutShinobu/ShinobuTranslator';

// Replaces model URLs in dist/models/manifest.json with GitHub Release URLs
// when MODEL_RELEASE_TAG is set (e.g. MODEL_RELEASE_TAG=models-v0.1.0).
function modelReleaseUrlPlugin(): Plugin {
  return {
    name: 'model-release-url',
    apply: 'build',
    closeBundle() {
      const tag = process.env.MODEL_RELEASE_TAG;
      if (!tag) return;
      const manifestPath = resolve(__dirname, 'dist/models/manifest.json');
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

// Chrome extension compat: content scripts are classic scripts (no import/export).
// This plugin bridges the gap between Vite's ES module output and Chrome's classic script injection:
// 1. Replaces import.meta.url with a chrome.runtime.getURL polyfill
// 2. Replaces dynamic import("./chunks/...") with import(chrome.runtime.getURL("chunks/..."))
// 3. Strips exports from content.js and sets up window.__shinobu_shared for chunk access
// 4. Replaces static import{...}from "../content.js" in chunks with window.__shinobu_shared lookup
function chromeExtensionContentScriptPlugin(): Plugin {
  return {
    name: 'chrome-extension-content-script',
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
          const mappings = exportMatch[1].split(',').map((s: string) => s.trim());
          // Build: {Name1: Var1, Name2: Var2, ...} (or just {name} if no alias)
          const pairs = mappings.map((m: string) => {
            const aliasMatch = m.match(/^(\S+)\s+as\s+(\S+)$/);
            if (aliasMatch) return `${aliasMatch[2]}:${aliasMatch[1]}`;
            return `${m}:${m}`;
          });
          // Inject global bridge BEFORE stripping exports, so variables are still in scope
          chunk.code = chunk.code.replace(
            /export\s*\{[^}]+\}\s*;\s*$/,
            `window.__shinobu_shared={${pairs.join(',')}};`,
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
          for (const si of staticImports) {
            const destructured = si.bindings.replace(/\bas\b/g, ':');
            chunk.code = chunk.code.replace(
              si.full,
              `const {${destructured.trim()}}=await import(chrome.runtime.getURL("${si.path}"));`,
            );
          }
          chunk.code = `(async()=>{${chunk.code}})();`;
        }
      }

      // Phase 2: Process chunks — replace static import from "../content.js" with global lookup
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !fileName.startsWith('chunks/')) continue;

        // Replace: import{g as ft, a as J, ...} from "../content.js"
        // With:    const {g: ft, a: J, ...} = window.__shinobu_shared;
        // Note: import uses "as" for renaming, destructuring uses ":"
        chunk.code = chunk.code.replace(
          /import\s*\{([^}]+)\}\s*from\s*"(\.\.\/content\.js|\.\/content\.js)"\s*;?/,
          (_match: string, imports: string) => {
            const converted = imports.replace(/\bas\b/g, ':');
            return `const {${converted.trim()}}=window.__shinobu_shared;`;
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

export default defineConfig({
  plugins: [react(), chromeExtensionContentScriptPlugin(), modelReleaseUrlPlugin()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => `${chunkInfo.name}.js`,
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});