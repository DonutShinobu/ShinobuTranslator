import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

// Replace import.meta.url in content script with a Chrome extension compatible polyfill
function chromeExtensionContentScriptPlugin(): Plugin {
  return {
    name: 'chrome-extension-content-script',
    enforce: 'post',
    generateBundle(_options, bundle) {
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

        chunk.code = chunk.code.replace(/export\s*\{[^}]*\}\s*;\s*$/, '');
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
