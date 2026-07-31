import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readCliOption } from './cli-options.mjs';

const root = resolve(import.meta.dirname, '../../..');
const extensionRoot = resolve(import.meta.dirname, '..');
const defaultSourceDirectory = resolve(extensionRoot, 'dist/firefox');

// These generated bundles come from pinned React/ORT dependencies and are
// independently constrained by the release-boundary content checks. Keep the
// exclusion exact so every extension-owned artifact remains under web-ext.
export const firefoxLintVendorExclusions = Object.freeze([
  'chunks/reactVendor.js',
  'onnxWorker.js',
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.jsep.mjs',
]);

export function assertFirefoxLintResult({ status, report, stderr }) {
  if (
    status !== 0
    || report?.summary?.errors !== 0
    || report?.summary?.warnings !== 0
  ) {
    const firstFinding = report?.errors?.[0] ?? report?.warnings?.[0];
    throw new Error(
      `Firefox lint failed (exit ${String(status)}, errors ${String(report?.summary?.errors)}, warnings ${String(report?.summary?.warnings)}): ${String(firstFinding?.code ?? stderr)}`,
    );
  }
}

function runFirefoxLint(argumentsList) {
  const sourceDirectory = resolve(
    process.cwd(),
    readCliOption(argumentsList, '--source-dir') ?? defaultSourceDirectory,
  );
  for (const path of firefoxLintVendorExclusions) {
    if (!existsSync(resolve(sourceDirectory, path))) {
      throw new Error(
        `Firefox lint vendor exclusion is missing from the release artifact: ${path}`,
      );
    }
  }
  const webExtCli = resolve(
    root,
    'tools/web-ext/node_modules/web-ext/bin/web-ext.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      webExtCli,
      'lint',
      '--source-dir',
      sourceDirectory,
      '--ignore-files',
      ...firefoxLintVendorExclusions,
      '--warnings-as-errors',
      '--output',
      'json',
      '--boring',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Firefox lint did not return JSON (exit ${String(result.status)}): ${result.stderr}`,
    );
  }
  assertFirefoxLintResult({
    status: result.status,
    report,
    stderr: result.stderr,
  });
  console.log('Firefox web-ext lint passed with zero findings.');
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runFirefoxLint(process.argv.slice(2));
}
