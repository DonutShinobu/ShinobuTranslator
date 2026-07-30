#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveExtensionBuildTarget } from './build-targets.mjs';

const extensionRoot = resolve(import.meta.dirname, '..');

function runCheck(scriptName, argumentsList) {
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, scriptName), ...argumentsList],
    {
      cwd: extensionRoot,
      stdio: 'inherit',
    },
  );
}

const chrome = resolveExtensionBuildTarget('chrome');
const firefox = resolveExtensionBuildTarget('firefox');

runCheck('check-release-boundaries.mjs', [
  '--dist',
  chrome.absoluteOutDir,
  '--target',
  chrome.target,
]);
runCheck('check-release-boundaries.mjs', [
  '--dist',
  firefox.absoluteOutDir,
  '--target',
  firefox.target,
]);
runCheck('check-manifest-pair.mjs', [
  '--chrome',
  resolve(chrome.absoluteOutDir, 'manifest.json'),
  '--firefox',
  resolve(firefox.absoluteOutDir, 'manifest.json'),
]);
