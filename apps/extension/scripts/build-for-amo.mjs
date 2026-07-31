#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectAmoArchiveEntries,
  collectAmoSourceEntries,
  writeAmoArtifacts,
} from './amo-artifacts.mjs';
import {
  AMO_BUILD_CONTRACT,
  assertAmoBuildEnvironment,
  assertNoAmoBuildEnvironmentFiles,
  assertAmoPackageMetadata,
  assertAmoReviewerEnvironment,
  verifyAmoBuildAssets,
} from './amo-build-contract.mjs';
import {
  resolveExtensionBuildTarget,
} from './build-targets.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const artifactsRoot = resolve(repositoryRoot, 'artifacts');
const outputDirectory = resolve(artifactsRoot, 'amo');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseOperatingSystemRelease(source) {
  const fields = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (
      value.length >= 2
      && value.startsWith('"')
      && value.endsWith('"')
    ) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }
  return fields;
}

function npmCliPath() {
  const path = process.env.npm_execpath;
  if (!path) {
    throw new Error(
      'AMO build must be invoked through npm run build-for-amo.',
    );
  }
  return path;
}

function runNpm(argumentsList, environment) {
  execFileSync(process.execPath, [npmCliPath(), ...argumentsList], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  });
}

function npmVersion() {
  return execFileSync(process.execPath, [npmCliPath(), '--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
}

function detectReviewerRuntime() {
  let operatingSystem = `${process.platform}`;
  if (process.platform === 'linux' && existsSync('/etc/os-release')) {
    const release = parseOperatingSystemRelease(
      readFileSync('/etc/os-release', 'utf8'),
    );
    operatingSystem = release.get('PRETTY_NAME') ?? operatingSystem;
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    operatingSystem,
    node: process.version.replace(/^v/u, ''),
    npm: npmVersion(),
  };
}

function childEnvironment() {
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  const retainedNpmConfiguration = new Set([
    'npm_config_cache',
    'npm_config_cafile',
    'npm_config_ca',
    'npm_config_https_proxy',
    'npm_config_noproxy',
    'npm_config_proxy',
    'npm_config_registry',
  ]);
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith('npm_config_')
      && !retainedNpmConfiguration.has(normalizedKey)
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function readPackageMetadata() {
  const packageMetadata = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
  );
  const lockfileBytes = readFileSync(
    resolve(repositoryRoot, 'package-lock.json'),
  );
  return {
    packageMetadata,
    lockfile: JSON.parse(lockfileBytes.toString('utf8')),
    lockfileBytes,
  };
}

function assertInstalledWebExt() {
  const packagePath = resolve(
    repositoryRoot,
    'node_modules/web-ext/package.json',
  );
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (installed.version !== AMO_BUILD_CONTRACT.install.webExt) {
    throw new Error(
      `Installed web-ext must be ${AMO_BUILD_CONTRACT.install.webExt}; received ${String(installed.version)}.`,
    );
  }
}

export function buildForAmo() {
  assertAmoBuildEnvironment(process.env);
  assertNoAmoBuildEnvironmentFiles({ root: repositoryRoot });
  const runtime = assertAmoReviewerEnvironment(detectReviewerRuntime());
  const initialMetadata = readPackageMetadata();
  assertAmoPackageMetadata(initialMetadata);

  rmSync(outputDirectory, { recursive: true, force: true });
  const environment = childEnvironment();
  runNpm(['ci', '--no-audit', '--no-fund'], environment);
  const installedMetadata = readPackageMetadata();
  assertAmoPackageMetadata(installedMetadata);
  assertInstalledWebExt();

  const assetProof = verifyAmoBuildAssets({ root: repositoryRoot });
  runNpm(['run', 'build:firefox'], environment);
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, 'check-firefox-lint.mjs')],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    },
  );

  const firefoxBuild = resolveExtensionBuildTarget('firefox');
  const xpiEntries = collectAmoArchiveEntries(
    firefoxBuild.absoluteOutDir,
  );
  const sourceEntries = collectAmoSourceEntries(repositoryRoot);
  const extensionPackage = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, 'apps/extension/package.json'),
      'utf8',
    ),
  );

  mkdirSync(artifactsRoot, { recursive: true });
  const stagingDirectory = mkdtempSync(
    resolve(artifactsRoot, '.amo-staging-'),
  );
  try {
    const result = writeAmoArtifacts({
      outputDirectory: stagingDirectory,
      extensionVersion: extensionPackage.version,
      xpiEntries,
      sourceEntries,
      receiptInputs: {
        runtime,
        lockfileSha256: sha256(installedMetadata.lockfileBytes),
        ...assetProof,
      },
    });
    renameSync(stagingDirectory, outputDirectory);
    console.log(
      `Canonical AMO artifacts created in ${outputDirectory}: ${Object.values(result.fileNames).join(', ')}`,
    );
    return result;
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    buildForAmo();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
