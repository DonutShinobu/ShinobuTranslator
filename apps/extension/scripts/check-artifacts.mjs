#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveExtensionBuildTarget } from './build-targets.mjs';

const extensionRoot = resolve(import.meta.dirname, '..');
const releaseBoundaryCheck = resolve(
  import.meta.dirname,
  'check-release-boundaries.mjs',
);
const manifestPairCheck = resolve(
  import.meta.dirname,
  'check-manifest-pair.mjs',
);

function runCheck(scriptPath, argumentsList) {
  execFileSync(
    process.execPath,
    [scriptPath, ...argumentsList],
    {
      cwd: extensionRoot,
      stdio: 'inherit',
    },
  );
}

const chrome = resolveExtensionBuildTarget('chrome');
const firefox = resolveExtensionBuildTarget('firefox');

runCheck(releaseBoundaryCheck, [
  '--dist',
  chrome.absoluteOutDir,
  '--target',
  chrome.target,
]);
runCheck(releaseBoundaryCheck, [
  '--dist',
  firefox.absoluteOutDir,
  '--target',
  firefox.target,
]);
runCheck(manifestPairCheck, [
  '--chrome',
  resolve(chrome.absoluteOutDir, 'manifest.json'),
  '--firefox',
  resolve(firefox.absoluteOutDir, 'manifest.json'),
]);
