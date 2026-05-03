import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

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
          '(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(fileName.replace(/^chunks\//, "")) : self.location.href)',
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), chromeExtensionContentScriptPlugin()],
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