import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dirname, '..');
const root = resolve(extensionRoot, '../..');
const chromium = join(extensionRoot, 'dist-chromium');
const store = join(extensionRoot, 'dist-chrome-store');
const version = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')).version;
const manifest = JSON.parse(readFileSync(join(chromium, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, version, 'Build the current Chromium version before the Chrome store variant.');
assert.equal(manifest.manifest_version, 3);
const dedicatedAdapterTokens = ['e-hentai.org', 'exhentai.org', 'data-mt-ehentai-anchor'];
const originalContent = readFileSync(join(chromium, 'content.js'), 'utf8');
for (const token of dedicatedAdapterTokens) assert.ok(originalContent.includes(token), `Full Chromium build is missing ${token}`);

// Only this fixed build directory is replaced; the full Chromium output remains intact.
assert.equal(store, resolve(root, 'apps/extension/dist-chrome-store'));
rmSync(store, { recursive: true, force: true });
cpSync(chromium, store, { recursive: true });
execFileSync(process.execPath, [
  join(extensionRoot, 'scripts/build-content.mjs'), '--out-dir', store, '--chrome-store',
], { cwd: extensionRoot, stdio: 'inherit' });

const storeContent = readFileSync(join(store, 'content.js'), 'utf8');
for (const token of dedicatedAdapterTokens) assert.ok(!storeContent.includes(token), `Chrome store build contains ${token}`);
function checkSharedFiles(directory, relative = '') {
  assert.deepEqual(
    readdirSync(directory).sort(), readdirSync(join(chromium, relative)).sort(),
    `Chrome store variant unexpectedly changed the file list in ${relative || '.'}`,
  );
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) checkSharedFiles(join(directory, entry.name), name);
    else if (name !== 'content.js') assert.ok(
      readFileSync(join(chromium, name)).equals(readFileSync(join(store, name))),
      `Chrome store variant unexpectedly changed ${name}`,
    );
  }
}
checkSharedFiles(store);
execFileSync(process.execPath, [
  join(root, 'scripts/check-release-boundaries.mjs'), '--target', 'chromium', '--dist', store,
], { cwd: root, stdio: 'inherit' });
console.log('Chrome store variant verified: dedicated eHentai/ExHentai adapter excluded; all other artifacts unchanged.');
