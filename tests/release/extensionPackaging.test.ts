import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { expect, it } from 'vitest';

it('packages chrome and firefox ZIPs while retaining source and checksums for internal use', async () => {
  const temporaryRoot = resolve('.tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'release-package-test-'));
  const script = join(directory, 'scripts/package-extensions.mjs');
  const artifacts = join(directory, 'artifacts');
  const chromium = join(directory, 'apps/extension/dist-chromium');
  const chromeStore = join(directory, 'apps/extension/dist-chrome-store');
  const firefox = join(directory, 'apps/extension/dist-firefox');
  try {
    mkdirSync(join(directory, 'scripts'));
    copyFileSync(resolve('scripts/package-extensions.mjs'), script);
    for (const dist of [chromium, firefox, chromeStore]) {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
      writeFileSync(join(dist, 'content.js'), dist === chromeStore ? 'chrome store' : dist === chromium ? 'full chrome' : 'full firefox');
    }
    writeFileSync(join(directory, 'apps/extension/package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(directory, 'README.md'), 'source documentation');
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    const args = [script, '--chromium', chromium, '--firefox', firefox, '--artifacts', artifacts];
    execFileSync(process.execPath, args, { cwd: directory });

    expect(readdirSync(artifacts).sort()).toEqual([
      'SHA256SUMS.txt',
      'ShinobuTranslator-chrome-v1.2.3.zip',
      'ShinobuTranslator-firefox-v1.2.3.zip',
      'ShinobuTranslator-source-v1.2.3.zip',
    ]);
    for (const browser of ['chrome', 'firefox']) {
      const zip = await JSZip.loadAsync(readFileSync(join(artifacts, `ShinobuTranslator-${browser}-v1.2.3.zip`)));
      expect(await zip.file('content.js')?.async('string')).toBe(`full ${browser}`);
      expect(JSON.parse(await zip.file('manifest.json')!.async('string')).version).toBe('1.2.3');
    }
    const source = await JSZip.loadAsync(readFileSync(join(artifacts, 'ShinobuTranslator-source-v1.2.3.zip')));
    expect(await source.file('README.md')?.async('string')).toBe('source documentation');
    expect(Object.keys(source.files).some((path) => path.startsWith('artifacts/') || path.includes('/dist-'))).toBe(false);
    const checksums = readFileSync(join(artifacts, 'SHA256SUMS.txt'), 'utf8');
    for (const filename of readdirSync(artifacts).filter((name) => name.endsWith('.zip'))) {
      const hash = createHash('sha256').update(readFileSync(join(artifacts, filename))).digest('hex');
      expect(checksums).toContain(`${hash}  ${filename}\n`);
    }

    execFileSync(process.execPath, [script, '--chromium', chromeStore, '--artifacts', join(artifacts, 'chrome-store')], { cwd: directory });
    const store = await JSZip.loadAsync(readFileSync(join(artifacts, 'chrome-store/ShinobuTranslator-chrome-v1.2.3.zip')));
    expect(await store.file('content.js')?.async('string')).toBe('chrome store');
    const fullChrome = await JSZip.loadAsync(readFileSync(join(artifacts, 'ShinobuTranslator-chrome-v1.2.3.zip')));
    expect(await fullChrome.file('content.js')?.async('string')).toBe('full chrome');

    writeFileSync(join(chromium, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
    const mismatch = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('chrome manifest version does not match extension package version');
  } finally {
    if (!directory.startsWith(join(temporaryRoot, 'release-package-test-'))) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
