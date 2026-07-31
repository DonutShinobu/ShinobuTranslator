export const AMO_BUILD_CONTRACT = Object.freeze({
  schemaVersion: 1,
  reviewerRuntime: Object.freeze({
    platform: 'linux',
    architecture: 'arm64',
    operatingSystem: 'Ubuntu 24.04.4 LTS',
    node: '24.14.0',
    npm: '11.9.0',
  }),
  install: Object.freeze({
    command: 'npm ci --no-audit --no-fund',
    lockfileVersion: 3,
    webExt: '10.5.0',
  }),
  modelPackageVersion: '2026-07-28-runtime-v1',
  archive: Object.freeze({
    warningBytes: 190_000_000,
    hardLimitBytes: 200_000_000,
  }),
});

const allowedNpmConfigVariables = new Set([
  'npm_config_cache',
  'npm_config_cafile',
  'npm_config_ca',
  'npm_config_globalconfig',
  'npm_config_global_prefix',
  'npm_config_https_proxy',
  'npm_config_init_module',
  'npm_config_local_prefix',
  'npm_config_loglevel',
  'npm_config_node_gyp',
  'npm_config_noproxy',
  'npm_config_npm_version',
  'npm_config_prefix',
  'npm_config_proxy',
  'npm_config_registry',
  'npm_config_user_agent',
  'npm_config_userconfig',
]);
const requiredStaticAssetPaths = new Set([
  'public/models/models.json',
  'apps/extension/src/ort/ort-wasm-simd-threaded.asyncify.mjs',
  'public/ort/ort-wasm-simd-threaded.asyncify.wasm',
  'apps/extension/src/ort/ort-wasm-simd-threaded.jsep.mjs',
  'public/ort/ort-wasm-simd-threaded.jsep.wasm',
  'apps/extension/src/ort/ort-wasm-simd-threaded.mjs',
  'public/ort/ort-wasm-simd-threaded.wasm',
  'public/fonts/SourceHanSansCN-VF.ttf.woff2',
  'public/fonts/SourceHanSansTW-VF.ttf.woff2',
]);

export function assertAmoReviewerEnvironment(runtime) {
  const expected = AMO_BUILD_CONTRACT.reviewerRuntime;
  for (const field of [
    'platform',
    'architecture',
    'operatingSystem',
    'node',
    'npm',
  ]) {
    if (runtime[field] !== expected[field]) {
      throw new Error(
        `AMO artifacts require the Mozilla reviewer runtime; expected ${field}=${expected[field]}, received ${String(runtime[field])}.`,
      );
    }
  }
  return runtime;
}

export function assertAmoBuildEnvironment(environment) {
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'model_release_tag'
      || normalizedKey === 'node_env'
      || normalizedKey === 'node_options'
      || normalizedKey.startsWith('vite_')
      || normalizedKey.startsWith('web_ext_')
      || (
        normalizedKey.startsWith('npm_config_')
        && !allowedNpmConfigVariables.has(normalizedKey)
      )
    ) {
      throw new Error(
        `AMO build rejects semantic environment input ${key}.`,
      );
    }
  }
}

export function assertNoAmoBuildEnvironmentFiles({ root }) {
  for (const entry of readdirSync(resolve(root), {
    withFileTypes: true,
  })) {
    const normalizedName = entry.name.toLowerCase();
    if (
      normalizedName === '.env'
      || normalizedName.startsWith('.env.')
    ) {
      throw new Error(
        `AMO build rejects Vite environment file ${entry.name}.`,
      );
    }
  }
}

export function assertAmoPackageMetadata({
  packageMetadata,
  lockfile,
}) {
  const expectedRuntime = AMO_BUILD_CONTRACT.reviewerRuntime;
  const expectedScript =
    'node apps/extension/scripts/build-for-amo.mjs';
  const expectedPackageManager = `npm@${expectedRuntime.npm}`;
  const expectedEngines = {
    node: expectedRuntime.node,
    npm: expectedRuntime.npm,
  };
  const lockedRoot = lockfile?.packages?.[''];
  const lockedWebExt = lockfile?.packages?.['node_modules/web-ext'];

  if (packageMetadata.packageManager !== expectedPackageManager) {
    throw new Error(
      `AMO root packageManager must be ${expectedPackageManager}.`,
    );
  }
  if (
    JSON.stringify(packageMetadata.engines)
    !== JSON.stringify(expectedEngines)
  ) {
    throw new Error('AMO root package engines do not match the reviewer runtime.');
  }
  if (packageMetadata.scripts?.['build-for-amo'] !== expectedScript) {
    throw new Error(`AMO root command must be ${expectedScript}.`);
  }
  if (lockfile?.lockfileVersion !== AMO_BUILD_CONTRACT.install.lockfileVersion) {
    throw new Error(
      `AMO build requires lockfile v${AMO_BUILD_CONTRACT.install.lockfileVersion}.`,
    );
  }
  if (
    JSON.stringify(lockedRoot?.engines)
      !== JSON.stringify(expectedEngines)
    || lockedRoot?.devDependencies?.['web-ext']
      !== AMO_BUILD_CONTRACT.install.webExt
    || packageMetadata.devDependencies?.['web-ext']
      !== AMO_BUILD_CONTRACT.install.webExt
    || lockedWebExt?.version !== AMO_BUILD_CONTRACT.install.webExt
  ) {
    throw new Error(
      `AMO lockfile must pin web-ext ${AMO_BUILD_CONTRACT.install.webExt} and reviewer engines.`,
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertLockedFile(root, asset, label) {
  if (
    typeof asset?.path !== 'string'
    || asset.path.length === 0
    || asset.path.startsWith('/')
    || asset.path.includes('\\')
    || asset.path.split('/').includes('..')
    || !Number.isSafeInteger(asset.size)
    || asset.size < 0
    || typeof asset.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(asset.sha256)
  ) {
    throw new Error(`Invalid ${label} asset lock: ${JSON.stringify(asset)}`);
  }
  const absolutePath = resolve(root, asset.path);
  let stats;
  let bytes;
  try {
    stats = statSync(absolutePath);
    bytes = readFileSync(absolutePath);
  } catch {
    throw new Error(`${label} asset is missing: ${asset.path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} asset is not a file: ${asset.path}`);
  }
  if (stats.size !== asset.size) {
    throw new Error(
      `${label} asset size mismatch for ${asset.path}: expected ${asset.size}, received ${stats.size}.`,
    );
  }
  const actualHash = sha256(bytes);
  if (actualHash !== asset.sha256) {
    throw new Error(
      `${label} asset hash mismatch for ${asset.path}: expected ${asset.sha256}, received ${actualHash}.`,
    );
  }
}

function parseModelChecksums(source) {
  const checksums = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/u);
    if (!match || checksums.has(match[2])) {
      throw new Error('Invalid or duplicate public/models/models.sha256 entry.');
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function collectRuntimeModelAssets(runtimeMetadata) {
  const assets = new Map();
  for (const model of Object.values(runtimeMetadata.models ?? {})) {
    for (const descriptor of [
      {
        url: model?.url,
        size: model?.size,
        sha256: model?.sha256,
      },
      {
        url: model?.dictUrl,
        size: model?.dictSize,
        sha256: model?.dictSha256,
      },
    ]) {
      if (descriptor.url === undefined) continue;
      if (
        typeof descriptor.url !== 'string'
        || !descriptor.url.startsWith('/models/')
        || basename(descriptor.url) !== descriptor.url.slice('/models/'.length)
        || !Number.isSafeInteger(descriptor.size)
        || descriptor.size <= 0
        || typeof descriptor.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)
      ) {
        throw new Error(
          `Invalid AMO runtime model metadata: ${JSON.stringify(descriptor)}`,
        );
      }
      const path = descriptor.url.slice('/models/'.length);
      if (assets.has(path)) {
        throw new Error(`Duplicate AMO runtime model asset: ${path}`);
      }
      assets.set(path, {
        size: descriptor.size,
        sha256: descriptor.sha256,
      });
    }
  }
  return assets;
}

export function verifyAmoBuildAssets({ root }) {
  const canonicalManifestPath = resolve(
    root,
    'packages/model-manifest/manifest.json',
  );
  const staticManifestPath = resolve(
    root,
    'apps/extension/amo-build-assets.json',
  );
  const runtimeMetadataPath = resolve(root, 'public/models/models.json');
  const canonicalManifestBytes = readFileSync(canonicalManifestPath);
  const staticManifestBytes = readFileSync(staticManifestPath);
  const canonicalManifest = JSON.parse(canonicalManifestBytes.toString('utf8'));
  const staticManifest = JSON.parse(staticManifestBytes.toString('utf8'));
  if (
    canonicalManifest.version !== AMO_BUILD_CONTRACT.modelPackageVersion
    || !Array.isArray(canonicalManifest.assets)
    || canonicalManifest.assets.length !== 5
  ) {
    throw new Error(
      `AMO build requires exactly five ${AMO_BUILD_CONTRACT.modelPackageVersion} model assets.`,
    );
  }
  if (
    staticManifest.schemaVersion !== 1
    || !Array.isArray(staticManifest.assets)
  ) {
    throw new Error('Invalid AMO static asset manifest.');
  }

  const staticPaths = new Set();
  const staticRoles = new Set();
  for (const asset of staticManifest.assets) {
    if (
      !['runtime-metadata', 'ort', 'font'].includes(asset?.role)
      || staticPaths.has(asset.path)
    ) {
      throw new Error(`Invalid or duplicate AMO static asset: ${asset?.path}`);
    }
    staticPaths.add(asset.path);
    staticRoles.add(asset.role);
    assertLockedFile(root, asset, 'AMO static');
  }
  for (const requiredRole of ['runtime-metadata', 'ort', 'font']) {
    if (!staticRoles.has(requiredRole)) {
      throw new Error(`AMO static asset manifest is missing ${requiredRole}.`);
    }
  }
  for (const path of requiredStaticAssetPaths) {
    if (!staticPaths.has(path)) {
      throw new Error(`AMO static asset manifest is missing ${path}.`);
    }
  }
  for (const path of staticPaths) {
    if (!requiredStaticAssetPaths.has(path)) {
      throw new Error(`AMO static asset manifest has undeclared path ${path}.`);
    }
  }

  const runtimeMetadata = readJson(runtimeMetadataPath);
  if (runtimeMetadata.version !== canonicalManifest.version) {
    throw new Error(
      'AMO runtime metadata version does not match the canonical model manifest.',
    );
  }
  const runtimeAssets = collectRuntimeModelAssets(runtimeMetadata);
  const checksums = parseModelChecksums(
    readFileSync(resolve(root, 'public/models/models.sha256'), 'utf8'),
  );
  const canonicalPaths = new Set();
  for (const asset of canonicalManifest.assets) {
    if (
      typeof asset?.path !== 'string'
      || basename(asset.path) !== asset.path
      || canonicalPaths.has(asset.path)
    ) {
      throw new Error(
        `Invalid or duplicate canonical model asset: ${asset?.path}`,
      );
    }
    canonicalPaths.add(asset.path);
    const sourceAsset = {
      ...asset,
      path: `public/models/${asset.path}`,
    };
    assertLockedFile(root, sourceAsset, 'Canonical model');
    const runtimeAsset = runtimeAssets.get(asset.path);
    if (
      runtimeAsset?.size !== asset.size
      || runtimeAsset?.sha256 !== asset.sha256
    ) {
      throw new Error(
        `Runtime metadata does not match canonical model asset ${asset.path}.`,
      );
    }
    if (checksums.get(asset.path) !== asset.sha256) {
      throw new Error(
        `models.sha256 does not match canonical model asset ${asset.path}.`,
      );
    }
  }
  if (
    runtimeAssets.size !== canonicalPaths.size
    || checksums.size !== canonicalPaths.size
  ) {
    throw new Error(
      'AMO runtime metadata or models.sha256 contains undeclared model assets.',
    );
  }

  return {
    modelManifestVersion: canonicalManifest.version,
    modelManifestSha256: sha256(canonicalManifestBytes),
    staticAssetManifestSha256: sha256(staticManifestBytes),
  };
}
import { createHash } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
