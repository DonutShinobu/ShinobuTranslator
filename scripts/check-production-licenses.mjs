#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = resolve(ROOT, 'THIRD_PARTY_DEPENDENCIES.json');
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '(MIT OR CC0-1.0)',
]);

function queryProductionPackages() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = npmCli
    ? [npmCli, 'query', ':not(.dev)', '--json']
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm query ":not(.dev)" --json']
      : ['query', ':not(.dev)', '--json'];
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `npm query failed with exit code ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function normalizedPackages(records) {
  const unique = new Map();
  for (const record of records) {
    if (
      !record
      || typeof record !== 'object'
      || record.name === 'manga-translate-web'
      || String(record.name ?? '').startsWith('@shinobu/')
    ) {
      continue;
    }
    const item = {
      name: String(record.name ?? ''),
      version: String(record.version ?? ''),
      license: String(record.license ?? 'NOASSERTION'),
    };
    if (!item.name || !item.version) {
      throw new Error('npm returned a production package without a name or version');
    }
    unique.set(`${item.name}@${item.version}`, item);
  }
  return [...unique.values()].sort(
    (left, right) => left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version),
  );
}

const report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
if (report.schemaVersion !== 1 || !Array.isArray(report.packages)) {
  throw new Error('THIRD_PARTY_DEPENDENCIES.json has an unsupported schema');
}

const current = normalizedPackages(queryProductionPackages());
const unreviewed = current.filter((item) => !ALLOWED_LICENSES.has(item.license));
if (unreviewed.length > 0) {
  throw new Error(
    `Unreviewed production dependency licenses:\n${
      unreviewed.map((item) => `- ${item.name}@${item.version}: ${item.license}`).join('\n')
    }`,
  );
}

if (JSON.stringify(report.packages) !== JSON.stringify(current)) {
  throw new Error(
    'Production dependency tree no longer matches THIRD_PARTY_DEPENDENCIES.json; '
    + 'review the new exact versions and licenses before updating the report.',
  );
}

console.log(
  `Production dependency licenses verified: ${current.length} exact package versions, `
  + `${new Set(current.map((item) => item.license)).size} reviewed license expressions.`,
);
