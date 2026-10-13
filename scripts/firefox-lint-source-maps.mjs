import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import { firefoxColdStartBanner } from './cold-start-defaults.mjs';

const root = resolve(import.meta.dirname, '..');
const auditedBundles = new Set(['popup.js', 'content.js']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const auditDirectory = dist => join(root, '.tmp/firefox-lint-source-maps', sha256(resolve(dist)));

export function firefoxLintSourceMapsPlugin(outputDir) {
  return {
    name: 'firefox-lint-source-maps',
    apply: 'build',
    config: () => ({ build: { sourcemap: 'hidden' } }),
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk' || !auditedBundles.has(chunk.fileName)) continue;
          assert(chunk.code.startsWith(`${firefoxColdStartBanner}\n`),
            `Firefox lint source maps must run after the cold-start banner: ${chunk.fileName}`);
          assert(chunk.map, `Missing Firefox lint source map: ${chunk.fileName}`);
          const sourceMap = JSON.parse(chunk.map.toString());
          // The cold-start plugin prepends one line after Rollup generates its map.
          sourceMap.mappings = `;${sourceMap.mappings}`;
          mkdirSync(auditDirectory(outputDir), { recursive: true });
          writeFileSync(join(auditDirectory(outputDir), `${chunk.fileName}.json`), JSON.stringify({
            bundleSha256: sha256(chunk.code), sourceMap,
          }));
        }
        for (const [file, output] of Object.entries(bundle)) {
          if (output.type === 'asset' && file.endsWith('.map')) delete bundle[file];
        }
      },
    },
  };
}

export function readLintWarningSource(dist, warning) {
  assert(auditedBundles.has(warning.file), `Unsupported Firefox lint source map: ${warning.file}`);
  const audit = JSON.parse(readFileSync(join(auditDirectory(dist), `${warning.file}.json`), 'utf8'));
  return decodeLintWarningSource(dist, warning, readFileSync(resolve(dist, warning.file)), audit);
}

export function decodeLintWarningSource(dist, warning, bundleBytes, audit) {
  assert(auditedBundles.has(warning.file), `Unsupported Firefox lint source map: ${warning.file}`);
  assert.equal(sha256(bundleBytes), audit.bundleSha256, `Stale Firefox lint source map: ${warning.file}`);
  assert(Number.isInteger(warning.line) && warning.line > 0
    && Number.isInteger(warning.column) && warning.column > 0,
  `Missing or invalid Firefox lint warning coordinates: ${warning.file}`);
  const generatedLines = Buffer.from(bundleBytes).toString('utf8').split(/\r?\n/u);
  assert(warning.line <= generatedLines.length
    && warning.column <= generatedLines[warning.line - 1].length,
  `Firefox lint warning coordinates are outside the bundle: ${warning.file}`);

  const map = audit.sourceMap;
  assert(map?.version === 3 && Array.isArray(map.sources) && typeof map.mappings === 'string',
    `Invalid Firefox lint source map: ${warning.file}`);
  const entry = traceSegment(new TraceMap(map), warning.line - 1, warning.column - 1);
  // A one-field segment marks an unmapped span, not the preceding dependency.
  assert(entry?.length >= 4
    && Number.isInteger(entry[2]) && entry[2] >= 0
    && Number.isInteger(entry[3]) && entry[3] >= 0,
  `Unmapped Firefox lint warning: ${warning.file}`);
  const index = entry[1];
  assert(Number.isInteger(index) && index >= 0 && typeof map.sources[index] === 'string',
    `Invalid Firefox lint source: ${warning.file}`);
  const content = map.sourcesContent?.[index];
  assert(typeof content === 'string', `Missing Firefox lint source content: ${warning.file}`);

  const source = map.sources[index];
  const sourceRoot = map.sourceRoot ?? '';
  assert(typeof sourceRoot === 'string' && !source.includes('\0') && !sourceRoot.includes('\0'),
    `Invalid Firefox lint source path: ${warning.file}`);
  const fromMap = resolve(dist, dirname(warning.file));
  let path;
  if (source.startsWith('file:')) path = fileURLToPath(source);
  else if (isAbsolute(source)) path = source;
  else if (sourceRoot.startsWith('file:')) {
    path = fileURLToPath(new URL(source, `${sourceRoot.replace(/\/$/u, '')}/`));
  } else {
    assert(!/^[a-z][a-z\d+.-]*:/iu.test(source)
      && (isAbsolute(sourceRoot) || !/^[a-z][a-z\d+.-]*:/iu.test(sourceRoot)),
      `Unsupported Firefox lint source URL: ${warning.file}`);
    path = resolve(fromMap, sourceRoot, source);
  }
  const repositorySource = relative(root, path).replaceAll('\\', '/');
  assert(repositorySource && repositorySource !== '..' && !repositorySource.startsWith('../')
    && !isAbsolute(repositorySource), `Firefox lint source is outside the repository: ${source}`);
  return {
    source: repositorySource,
    sha256: sha256(content),
    line: entry[2] + 1,
    column: entry[3] + 1,
  };
}
