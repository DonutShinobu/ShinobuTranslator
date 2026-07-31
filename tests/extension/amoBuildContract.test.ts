import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AMO_BUILD_CONTRACT,
  assertAmoBuildEnvironment,
  assertNoAmoBuildEnvironmentFiles,
  assertAmoPackageMetadata,
  assertAmoReviewerEnvironment,
  verifyAmoBuildAssets,
} from '../../apps/extension/scripts/amo-build-contract.mjs';

const root = process.cwd();
const temporaryDirectories: string[] = [];

function writeFixtureFile(
  fixtureRoot: string,
  path: string,
  bytes: string,
): void {
  const absolutePath = resolve(fixtureRoot, path);
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AMO build contract', () => {
  it('accepts only the pinned Mozilla reviewer runtime', () => {
    const canonical = {
      platform: 'linux',
      architecture: 'arm64',
      operatingSystem: 'Ubuntu 24.04.4 LTS',
      node: '24.14.0',
      npm: '11.9.0',
    };

    expect(assertAmoReviewerEnvironment(canonical)).toEqual(canonical);
    for (const drift of [
      { platform: 'win32' },
      { architecture: 'x64' },
      { operatingSystem: 'Ubuntu 24.04.3 LTS' },
      { node: '24.14.1' },
      { npm: '11.9.1' },
    ]) {
      expect(() =>
        assertAmoReviewerEnvironment({ ...canonical, ...drift }),
      ).toThrow('Mozilla reviewer runtime');
    }
    expect(AMO_BUILD_CONTRACT.reviewerRuntime).toEqual(canonical);
  });

  it('rejects semantic environment inputs while allowing tool discovery and fetch configuration', () => {
    expect(() =>
      assertAmoBuildEnvironment({
        PATH: '/usr/bin',
        npm_config_cache: '/tmp/npm-cache',
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_user_agent: 'npm/11.9.0 node/v24.14.0 linux arm64',
      }),
    ).not.toThrow();

    for (const variable of [
      'MODEL_RELEASE_TAG',
      'VITE_REMOTE_MODELS',
      'WEB_EXT_API_KEY',
      'NODE_OPTIONS',
      'NODE_ENV',
      'npm_config_ignore_scripts',
      'npm_config_omit',
      'npm_config_platform',
      'NPM_CONFIG_IGNORE_SCRIPTS',
      'NPM_CONFIG_OMIT',
    ]) {
      expect(() =>
        assertAmoBuildEnvironment({ [variable]: 'changed' }),
      ).toThrow(variable);
    }
  });

  it('rejects repository dotenv files that Vite would load as semantic build input', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'shinobu-amo-env-'));
    temporaryDirectories.push(fixtureRoot);

    expect(() =>
      assertNoAmoBuildEnvironmentFiles({ root: fixtureRoot }),
    ).not.toThrow();

    for (const path of [
      '.env',
      '.env.local',
      '.env.firefox',
      '.env.firefox.local',
      '.env.production',
    ]) {
      writeFixtureFile(fixtureRoot, path, 'VITE_REMOTE_MODELS=1\n');
      expect(() =>
        assertNoAmoBuildEnvironmentFiles({ root: fixtureRoot }),
      ).toThrow(path);
      rmSync(resolve(fixtureRoot, path));
    }
  });

  it('pins the root command, reviewer engines, lockfile v3, npm ci, and web-ext 10.5.0', () => {
    const packageMetadata = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );
    const lockfile = JSON.parse(
      readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
    );

    expect(() =>
      assertAmoPackageMetadata({ packageMetadata, lockfile }),
    ).not.toThrow();
    expect(packageMetadata.scripts['build-for-amo']).toBe(
      'node apps/extension/scripts/build-for-amo.mjs',
    );
    expect(AMO_BUILD_CONTRACT.install.command).toBe(
      'npm ci --no-audit --no-fund',
    );
  });

  it('cross-checks five bundled model assets and every locked runtime, ORT, and font byte before build', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'shinobu-amo-assets-'));
    temporaryDirectories.push(fixtureRoot);
    const modelAssets = [
      ['detector.onnx', 'a', 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'],
      ['inpaint.onnx', 'b', '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d'],
      ['bubble.onnx', 'c', '2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6'],
      ['ocr.onnx', 'd', '18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4'],
      ['dict.txt', 'e', '3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea'],
    ] as const;
    const canonicalManifest = {
      schemaVersion: 1,
      version: AMO_BUILD_CONTRACT.modelPackageVersion,
      assets: modelAssets.map(([path, bytes, sha256], index) => ({
        id: `asset-${index}`,
        path,
        size: Buffer.byteLength(bytes),
        sha256,
        mediaType: 'application/octet-stream',
      })),
    };
    const runtimeMetadata = {
      schemaVersion: 1,
      version: AMO_BUILD_CONTRACT.modelPackageVersion,
      models: {
        detector: {
          url: '/models/detector.onnx',
          size: 1,
          sha256: modelAssets[0][2],
        },
        inpaint: {
          url: '/models/inpaint.onnx',
          size: 1,
          sha256: modelAssets[1][2],
        },
        bubble: {
          url: '/models/bubble.onnx',
          size: 1,
          sha256: modelAssets[2][2],
        },
        ocr: {
          url: '/models/ocr.onnx',
          size: 1,
          sha256: modelAssets[3][2],
          dictUrl: '/models/dict.txt',
          dictSize: 1,
          dictSha256: modelAssets[4][2],
        },
      },
    };
    const runtimeBytes = `${JSON.stringify(runtimeMetadata, null, 2)}\n`;
    const staticFiles = [
      {
        role: 'runtime-metadata',
        path: 'public/models/models.json',
        bytes: runtimeBytes,
      },
      {
        role: 'ort',
        path: 'apps/extension/src/ort/ort-wasm-simd-threaded.asyncify.mjs',
        bytes: 'ort-asyncify-js',
      },
      {
        role: 'ort',
        path: 'public/ort/ort-wasm-simd-threaded.asyncify.wasm',
        bytes: 'ort-asyncify-wasm',
      },
      {
        role: 'ort',
        path: 'apps/extension/src/ort/ort-wasm-simd-threaded.jsep.mjs',
        bytes: 'ort-jsep-js',
      },
      {
        role: 'ort',
        path: 'public/ort/ort-wasm-simd-threaded.jsep.wasm',
        bytes: 'ort-jsep-wasm',
      },
      {
        role: 'ort',
        path: 'apps/extension/src/ort/ort-wasm-simd-threaded.mjs',
        bytes: 'ort-js',
      },
      {
        role: 'ort',
        path: 'public/ort/ort-wasm-simd-threaded.wasm',
        bytes: 'ort-wasm',
      },
      {
        role: 'font',
        path: 'public/fonts/SourceHanSansCN-VF.ttf.woff2',
        bytes: 'font-cn',
      },
      {
        role: 'font',
        path: 'public/fonts/SourceHanSansTW-VF.ttf.woff2',
        bytes: 'font-tw',
      },
    ];
    for (const [path, bytes] of modelAssets) {
      writeFixtureFile(fixtureRoot, `public/models/${path}`, bytes);
    }
    writeFixtureFile(
      fixtureRoot,
      'packages/model-manifest/manifest.json',
      `${JSON.stringify(canonicalManifest, null, 2)}\n`,
    );
    writeFixtureFile(
      fixtureRoot,
      'public/models/models.sha256',
      `${modelAssets.map(([path, , hash]) => `${hash}  ${path}`).join('\n')}\n`,
    );
    for (const asset of staticFiles) {
      writeFixtureFile(fixtureRoot, asset.path, asset.bytes);
    }
    const staticManifest = {
      schemaVersion: 1,
      assets: staticFiles.map((asset) => ({
          role: asset.role,
          path: asset.path,
          size: Buffer.byteLength(asset.bytes),
          sha256: createHash('sha256')
            .update(asset.bytes)
            .digest('hex'),
        })),
    };
    writeFixtureFile(
      fixtureRoot,
      'apps/extension/amo-build-assets.json',
      `${JSON.stringify(staticManifest, null, 2)}\n`,
    );

    expect(() => verifyAmoBuildAssets({ root: fixtureRoot })).not.toThrow();
    writeFixtureFile(fixtureRoot, 'public/models/detector.onnx', 'changed');
    expect(() => verifyAmoBuildAssets({ root: fixtureRoot })).toThrow(
      'public/models/detector.onnx',
    );
    writeFixtureFile(fixtureRoot, 'public/models/detector.onnx', 'a');
    writeFixtureFile(
      fixtureRoot,
      'apps/extension/amo-build-assets.json',
      `${JSON.stringify({
        ...staticManifest,
        assets: staticManifest.assets.filter(
          (asset) =>
            asset.path
            !== 'apps/extension/src/ort/ort-wasm-simd-threaded.asyncify.mjs',
        ),
      }, null, 2)}\n`,
    );
    expect(() => verifyAmoBuildAssets({ root: fixtureRoot })).toThrow(
      'apps/extension/src/ort/ort-wasm-simd-threaded.asyncify.mjs',
    );
  });
});
