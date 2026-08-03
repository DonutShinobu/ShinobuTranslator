import { resolve } from 'node:path';
import { build } from 'vite';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

const root = resolve(import.meta.dirname, '..');
const outputDir = resolve(process.cwd(), readRequiredOption('--out-dir'));

await build({
  configFile: false,
  root,
  publicDir: false,
  build: {
    outDir: outputDir,
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'ShinobuTranslatorContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
