import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = resolve(import.meta.dirname, '../..');
const bundle = await build({
  configFile: false, root, publicDir: false, plugins: [tailwindcss()],
  build: {
    write: false, sourcemap: 'inline',
    lib: { entry: resolve(root, 'tests/browser/layerEditorFixture.ts'), formats: ['iife'], name: 'layerFixture' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const fixture = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(file => file.type === 'chunk');
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/fixture.js"></script></body></html>';
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/fixture.js') {
    response.setHeader('content-type', 'text/javascript'); response.end(fixture.code);
  } else if (/^\/fonts\/SourceHanSans(?:CN|TW)-VF\.ttf\.woff2$/u.test(path)) {
    response.setHeader('content-type', 'font/woff2');
    response.end(await readFile(resolve(root, `public${path}`)));
  } else {
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
  }
});
server.listen(4178, '127.0.0.1');
const close = () => { server.closeAllConnections(); server.close(); };
process.on('SIGTERM', close); process.on('SIGINT', close);
