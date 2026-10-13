import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { firefoxColdStartPlugin } from '../../scripts/cold-start-defaults.mjs';
import {
  decodeLintWarningSource,
  firefoxLintSourceMapsPlugin,
  readLintWarningSource,
} from '../../scripts/firefox-lint-source-maps.mjs';

const root = resolve(import.meta.dirname, '../..');
const dist = resolve(root, '.tmp/firefox-lint-source-map-test/dist');
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const dependencySource = 'node_modules/prosemirror-view/src/clipboard.ts';
const originalCode = 'element.innerHTML = html;';

function fixture({ bundle = 'element.innerHTML=html;', mappings = 'AAAA', source = dependencySource } = {}) {
  return {
    bundle,
    audit: {
      bundleSha256: sha256(bundle),
      sourceMap: {
        version: 3,
        file: 'content.js',
        sourceRoot: '',
        names: [],
        sources: [relative(dist, resolve(root, source)).replaceAll('\\', '/')],
        sourcesContent: [originalCode],
        mappings,
      },
    },
  };
}

describe('Firefox lint warning source maps', () => {
  it('captures the final bundle and banner offset without shipping map assets', async () => {
    const tempRoot = resolve(root, '.tmp');
    mkdirSync(tempRoot, { recursive: true });
    const directory = mkdtempSync(join(tempRoot, 'firefox-lint-source-map-test-'));
    const outputDir = join(directory, 'dist-firefox');
    const auditDir = join(tempRoot, 'firefox-lint-source-maps', sha256(resolve(outputDir)));
    try {
      const entry = join(directory, 'entry.js');
      writeFileSync(entry, originalCode);
      await build({
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        plugins: [firefoxColdStartPlugin, firefoxLintSourceMapsPlugin(outputDir)],
        build: {
          outDir: outputDir,
          lib: { entry, formats: ['es'], fileName: () => 'content.js' },
        },
      });
      expect(readdirSync(outputDir)).toEqual(['content.js']);
      expect(existsSync(join(auditDir, 'content.js.json'))).toBe(true);
      expect(readLintWarningSource(outputDir, { file: 'content.js', line: 2, column: 1 }))
        .toMatchObject({ source: relative(root, entry).replaceAll('\\', '/'), sha256: sha256(originalCode), line: 1 });
    } finally {
      expect(directory.startsWith(`${tempRoot}\\`) || directory.startsWith(`${tempRoot}/`)).toBe(true);
      expect(auditDir.startsWith(`${tempRoot}\\`) || auditDir.startsWith(`${tempRoot}/`)).toBe(true);
      rmSync(directory, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('keeps the audited source stable when UI changes move a warning', () => {
    const before = fixture();
    const after = fixture({ bundle: 'ui();\nui();\nelement.innerHTML=html;', mappings: ';;AAAA' });
    const original = decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, before.bundle, before.audit);
    expect(original).toEqual({ source: dependencySource, sha256: sha256(originalCode), line: 1, column: 1 });
    expect(decodeLintWarningSource(dist, { file: 'content.js', line: 3, column: 1 }, after.bundle, after.audit)).toEqual(original);
  });

  it('identifies application code when it replaces a dependency warning with the same code and count', () => {
    const appSource = 'apps/extension/src/content/core/ui/translationButton.ts';
    const { bundle, audit } = fixture({ source: appSource });
    expect(decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, bundle, audit).source).toBe(appSource);
  });

  it('resolves sourceRoot relative to the map in the distribution directory', () => {
    const { bundle, audit } = fixture();
    const sourceRoot = relative(dist, resolve(root, 'node_modules/prosemirror-view/src')).replaceAll('\\', '/');
    const sourceMap = { ...audit.sourceMap, sourceRoot, sources: ['clipboard.ts'] };
    expect(decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, bundle, { ...audit, sourceMap }).source)
      .toBe(dependencySource);
  });

  it('rejects a stale map instead of attributing a changed bundle to an old source', () => {
    const { bundle, audit } = fixture();
    expect(() => decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, `${bundle}changed();`, audit))
      .toThrow('Stale Firefox lint source map');
  });

  it.each([
    { file: 'content.js' },
    { file: 'content.js', line: 0, column: 1 },
    { file: 'content.js', line: 1, column: -1 },
    { file: 'content.js', line: 1.5, column: 1 },
  ])('rejects missing or invalid warning coordinates: %j', warning => {
    const { bundle, audit } = fixture();
    expect(() => decodeLintWarningSource(dist, warning, bundle, audit)).toThrow('warning coordinates');
  });

  it('rejects unmapped positions, including a line following the last mapping', () => {
    const empty = fixture({ mappings: '' });
    expect(() => decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, empty.bundle, empty.audit))
      .toThrow('Unmapped Firefox lint warning');
    const previousLine = fixture({ bundle: 'ui();\nelement.innerHTML=html;' });
    expect(() => decodeLintWarningSource(dist, { file: 'content.js', line: 2, column: 1 }, previousLine.bundle, previousLine.audit))
      .toThrow('Unmapped Firefox lint warning');
  });

  it('rejects missing original source content', () => {
    const { bundle, audit } = fixture();
    const sourceMap = { ...audit.sourceMap, sourcesContent: [] };
    expect(() => decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 1 }, bundle, { ...audit, sourceMap }))
      .toThrow('Missing Firefox lint source content');
  });

  it('rejects an unmapped span on the same line as an audited dependency', () => {
    const { bundle, audit } = fixture({ mappings: 'AAAA,K' });
    expect(() => decodeLintWarningSource(dist, { file: 'content.js', line: 1, column: 6 }, bundle, audit))
      .toThrow('Unmapped Firefox lint warning');
  });
});
