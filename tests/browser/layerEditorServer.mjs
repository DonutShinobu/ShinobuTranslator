import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const bundle = await build({
  entryPoints: [resolve(root, 'tests/browser/layerEditorFixture.ts')], bundle: true,
  write: false, format: 'iife', platform: 'browser', sourcemap: 'inline',
});
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/fixture.js"></script></body></html>';
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/fixture.js') {
    response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].contents);
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
