import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scanRoots = [resolve(root, 'apps/extension')];
const sourceExtensions = /\.(?:ts|tsx|js|mjs|html)$/;
const runtimeAdapter = 'apps/extension/src/shared/extensionRuntime.ts';
const schemeAllowlist = new Set([
  runtimeAdapter,
  'apps/extension/src/shared/diagnosticLogClient.ts',
]);
const buildAdapterAllowlist = new Set([
  'apps/extension/manifest.ts',
  'apps/extension/vite.config.ts',
]);

function collectFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules'
      || entry.name === 'prototypes'
      || entry.name === 'dist'
      || entry.name.startsWith('dist-')
    ) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, result);
    else if (entry.isFile() && sourceExtensions.test(entry.name)) result.push(path);
  }
  return result;
}

const failures = [];
for (const path of scanRoots.flatMap((directory) => collectFiles(directory))) {
  const repoPath = relative(root, path).replaceAll('\\', '/');
  const source = readFileSync(path, 'utf8');
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/\b(?:chrome|browser)\s*\./.test(line) && repoPath !== runtimeAdapter) {
      failures.push(`${repoPath}:${index + 1} uses a raw browser namespace`);
    }
    if (/(?:shared\/chrome|ChromeLike|getChromeApi)/.test(line)) {
      failures.push(`${repoPath}:${index + 1} uses the removed Chrome-specific seam`);
    }
    if (/(?:chrome:\/\/|about:addons)/.test(line) && repoPath !== runtimeAdapter) {
      failures.push(`${repoPath}:${index + 1} embeds a browser-internal URL outside the runtime adapter`);
    }
    if (/(?:chrome-extension:|moz-extension:)/.test(line) && !schemeAllowlist.has(repoPath)) {
      failures.push(`${repoPath}:${index + 1} branches on an extension scheme outside the trust adapters`);
    }
    if (/\b(?:isFirefox|isChromium|browserTarget|extensionTarget)\b/.test(line)
      && !buildAdapterAllowlist.has(repoPath)) {
      failures.push(`${repoPath}:${index + 1} contains target detection outside a build adapter`);
    }
  }
}

if (failures.length) {
  throw new Error(`Extension architecture boundary violations:\n${failures.join('\n')}`);
}
console.log('Extension architecture boundaries verified.');
