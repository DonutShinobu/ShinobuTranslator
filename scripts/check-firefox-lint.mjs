import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLintWarningSource } from './firefox-lint-source-maps.mjs';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.cwd(), readRequiredOption('--dist'));
const baseline = JSON.parse(
  readFileSync(resolve(root, 'scripts/firefox-lint-baseline.json'), 'utf8'),
);
const webExtPackage = JSON.parse(
  readFileSync(resolve(root, 'node_modules/web-ext/package.json'), 'utf8'),
);
if (webExtPackage.version !== baseline.webExtVersion) {
  throw new Error(`web-ext version drift: expected ${baseline.webExtVersion}, got ${webExtPackage.version}`);
}

const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/web-ext/bin/web-ext.js'),
    'lint',
    '--source-dir',
    dist,
    '--output',
    'json',
    '--boring',
  ],
  { cwd: root, encoding: 'utf8' },
);
if (result.error) throw result.error;
if (!result.stdout.trim()) throw new Error(`web-ext lint returned no JSON: ${result.stderr}`);
const report = JSON.parse(result.stdout);
if (report.summary?.errors !== 0 || result.status !== 0) {
  throw new Error(`Firefox lint failed with ${report.summary?.errors ?? 'unknown'} errors:\n${result.stdout}`);
}

const actualWarnings = new Map();
for (const warning of report.warnings ?? []) {
  const key = `${warning.code}:${warning.file}`;
  actualWarnings.set(key, (actualWarnings.get(key) ?? 0) + 1);
}
const expectedWarnings = new Map();
for (const warning of baseline.warnings) {
  const key = `${warning.code}:${warning.file}`;
  expectedWarnings.set(key, warning.count);
  const dependencyPackage = JSON.parse(
    readFileSync(resolve(root, 'node_modules', warning.dependency, 'package.json'), 'utf8'),
  );
  if (dependencyPackage.version !== warning.dependencyVersion) {
    throw new Error(
      `Lint dependency drift for ${warning.file}: ${warning.dependency}@${dependencyPackage.version}`,
    );
  }
  // UI bundles change frequently; audit the original dependency code and locations.
  if (warning.source) {
    const locations = (report.warnings ?? [])
      .filter((actual) => actual.code === warning.code && actual.file === warning.file)
      .map((actual) => {
        const source = readLintWarningSource(dist, actual);
        if (source.source !== warning.source || source.sha256 !== warning.sourceSha256) {
          throw new Error(`Firefox lint warning source drift: ${warning.file} -> ${source.source}`);
        }
        return [source.line, source.column];
      });
    const sortLocations = (values) => [...values].sort(([a, b], [c, d]) => a - c || b - d);
    if (JSON.stringify(sortLocations(locations)) !== JSON.stringify(sortLocations(warning.locations))) {
      throw new Error(`Firefox lint warning locations changed in ${warning.source}`);
    }
  } else {
    const hash = createHash('sha256')
      .update(readFileSync(resolve(dist, warning.file)))
      .digest('hex');
    if (hash !== warning.sha256) {
      throw new Error(`Firefox lint baseline file hash drift: ${warning.file}`);
    }
  }
}
if (JSON.stringify([...actualWarnings].sort()) !== JSON.stringify([...expectedWarnings].sort())) {
  throw new Error(
    `Firefox lint warnings changed.\nExpected: ${JSON.stringify([...expectedWarnings])}\nActual: ${JSON.stringify([...actualWarnings])}`,
  );
}

console.log(`Firefox lint passed with 0 errors and ${report.summary.warnings} audited warnings.`);
