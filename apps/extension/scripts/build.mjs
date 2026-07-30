#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';
import {
  extensionBuildTargets,
  resolveExtensionBuildTarget,
} from './build-targets.mjs';
import {
  writeExtensionManifest,
} from './generate-manifest.mjs';
import { readCliOption } from './cli-options.mjs';

const extensionRoot = resolve(import.meta.dirname, '..');
const root = resolve(extensionRoot, '../..');
const extensionDistRoot = resolve(extensionRoot, 'dist');

function assertTargetOutputDirectory(outputDirectory) {
  const relativePath = relative(extensionDistRoot, outputDirectory);
  if (
    !relativePath
    || relativePath.startsWith('..')
    || resolve(extensionDistRoot, relativePath) !== outputDirectory
  ) {
    throw new Error(
      `Refusing to clean extension output outside an isolated target directory: ${outputDirectory}`,
    );
  }
}

function runNodeScript(scriptPath, argumentsList) {
  execFileSync(
    process.execPath,
    [scriptPath, ...argumentsList],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}

async function buildExtensionTarget(target) {
  const descriptor = resolveExtensionBuildTarget(target);
  assertTargetOutputDirectory(descriptor.absoluteOutDir);
  rmSync(descriptor.absoluteOutDir, { recursive: true, force: true });

  await viteBuild({
    root: extensionRoot,
    configFile: resolve(extensionRoot, 'vite.config.ts'),
    mode: target,
  });
  if (target === 'benchmark') {
    await viteBuild({
      root: extensionRoot,
      configFile: resolve(extensionRoot, 'vite.config.ts'),
      mode: 'benchmark-entry',
  });
}
  runNodeScript(resolve(root, 'scripts/build-worker.mjs'), [
    '--out-dir',
    descriptor.absoluteOutDir,
  ]);
  writeExtensionManifest({
    target: descriptor.manifestTarget,
    outputPath: resolve(descriptor.absoluteOutDir, 'manifest.json'),
  });
  runNodeScript(resolve(import.meta.dirname, 'check-release-boundaries.mjs'), [
    '--dist',
    descriptor.absoluteOutDir,
    '--target',
    target,
  ]);
}

function checkManifestPair() {
  runNodeScript(resolve(import.meta.dirname, 'check-manifest-pair.mjs'), [
    '--chrome',
    join(resolveExtensionBuildTarget('chrome').absoluteOutDir, 'manifest.json'),
    '--firefox',
    join(resolveExtensionBuildTarget('firefox').absoluteOutDir, 'manifest.json'),
  ]);
}

async function buildRequestedTargets(target) {
  runNodeScript(
    resolve(
      import.meta.dirname,
      'generate-browser-ort-entries.mjs',
    ),
    ['--check'],
  );
  if (target) {
    await buildExtensionTarget(target);
    return;
  }
  await buildExtensionTarget('chrome');
  await buildExtensionTarget('firefox');
  checkManifestPair();
}

async function runCli(argumentsList) {
  if (argumentsList.includes('--describe-targets')) {
    console.log(JSON.stringify(extensionBuildTargets));
    return;
  }
  const printedTarget = readCliOption(
    argumentsList,
    '--print-target-out-dir',
  );
  if (printedTarget) {
    console.log(resolveExtensionBuildTarget(printedTarget).outDir);
    return;
  }
  await buildRequestedTargets(readCliOption(argumentsList, '--target'));
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runCli(process.argv.slice(2));
}
