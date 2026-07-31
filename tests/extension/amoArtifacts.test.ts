import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAmoSourceEntries,
  enforceAmoArchiveSize,
  writeAmoArtifacts,
} from '../../apps/extension/scripts/amo-artifacts.mjs';
import {
  AMO_BUILD_CONTRACT,
} from '../../apps/extension/scripts/amo-build-contract.mjs';

const temporaryDirectories: string[] = [];

function writeFixture(
  root: string,
  path: string,
  bytes = `${path}\n`,
): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AMO artifact generation', () => {
  it('collects the source-root build allowlist while excluding dependencies, outputs, tests, research, agent metadata, credentials, and logs', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'shinobu-amo-source-'));
    temporaryDirectories.push(fixtureRoot);
    for (const path of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'LICENSE',
      'PRIVACY_POLICY.md',
      'THIRD_PARTY_DEPENDENCIES.json',
      'THIRD_PARTY_NOTICES.md',
      'AMO_SOURCE_BUILD.md',
      'apps/extension/package.json',
      'apps/extension/src/main.ts',
      'packages/runtime/package.json',
      'packages/runtime/src/index.ts',
      'src/background/index.ts',
      'public/models/model.onnx',
      'scripts/build-worker.mjs',
      'scripts/vite-browser-runtime-boundary.ts',
    ]) {
      writeFixture(fixtureRoot, path);
    }
    for (const deniedPath of [
      '.agents/skills/private.md',
      '.github/workflows/release.yml',
      '.git/config',
      'apps/extension/dist/firefox/manifest.json',
      'apps/extension/node_modules/module.js',
      'apps/extension/benchmark.html',
      'artifacts/amo/old.xpi',
      'benchmark/report.json',
      'docs/research/review.md',
      'node_modules/module.js',
      'public/build.log',
      'src/benchmark/debug.ts',
      'src/.env',
      'apps/extension/.npmrc',
      'apps/extension/.netrc',
      'apps/extension/.ssh/id_rsa',
      'apps/extension/config/credentials.yaml',
      'apps/extension/config/secrets.yml',
      'apps/extension/config/reviewer.p12',
      'apps/extension/config/signing.pfx',
      'apps/extension/config/signing.jks',
      'apps/extension/scripts/run-firefox-basic-smoke.mjs',
      'tests/extension/release.test.ts',
      'scripts/download-models.mjs',
      'scripts/upload-models.mjs',
    ]) {
      writeFixture(fixtureRoot, deniedPath);
    }

    const entries = collectAmoSourceEntries(fixtureRoot);

    expect(entries.map((entry) => entry.path)).toEqual([
      'AMO_SOURCE_BUILD.md',
      'LICENSE',
      'PRIVACY_POLICY.md',
      'THIRD_PARTY_DEPENDENCIES.json',
      'THIRD_PARTY_NOTICES.md',
      'apps/extension/package.json',
      'apps/extension/src/main.ts',
      'package-lock.json',
      'package.json',
      'packages/runtime/package.json',
      'packages/runtime/src/index.ts',
      'public/models/model.onnx',
      'scripts/build-worker.mjs',
      'scripts/vite-browser-runtime-boundary.ts',
      'src/background/index.ts',
      'tsconfig.json',
    ]);
  });

  it('writes path-independent XPI/source archives, sorted entry manifests, and one deterministic receipt', () => {
    const firstOutput = mkdtempSync(resolve(tmpdir(), 'shinobu-amo-output-a-'));
    const secondOutput = mkdtempSync(resolve(tmpdir(), 'shinobu-amo-output-b-'));
    temporaryDirectories.push(firstOutput, secondOutput);
    const xpiEntries = [
      { path: 'z.txt', bytes: Buffer.from('z') },
      { path: 'manifest.json', bytes: Buffer.from('{}\n') },
    ];
    const sourceEntries = [
      { path: 'src/index.ts', bytes: Buffer.from('export {};\n') },
      { path: 'package.json', bytes: Buffer.from('{}\n') },
    ];
    const receiptInputs = {
      runtime: AMO_BUILD_CONTRACT.reviewerRuntime,
      lockfileSha256: '1'.repeat(64),
      modelManifestVersion: AMO_BUILD_CONTRACT.modelPackageVersion,
      modelManifestSha256: '2'.repeat(64),
      staticAssetManifestSha256: '3'.repeat(64),
    };

    const first = writeAmoArtifacts({
      outputDirectory: firstOutput,
      extensionVersion: '0.8.1',
      xpiEntries,
      sourceEntries,
      receiptInputs,
    });
    const second = writeAmoArtifacts({
      outputDirectory: secondOutput,
      extensionVersion: '0.8.1',
      xpiEntries: [...xpiEntries].reverse(),
      sourceEntries: [...sourceEntries].reverse(),
      receiptInputs,
    });

    expect(first.fileNames).toEqual({
      xpi: 'shinobu-translator-0.8.1-firefox.xpi',
      source: 'shinobu-translator-0.8.1-source.zip',
      xpiManifest: 'xpi-files.sha256',
      sourceManifest: 'source-files.sha256',
      receipt: 'build-receipt.json',
    });
    for (const fileName of Object.values(first.fileNames)) {
      expect(
        readFileSync(resolve(firstOutput, fileName)).equals(
          readFileSync(resolve(secondOutput, fileName)),
        ),
      ).toBe(true);
    }
    expect(
      readFileSync(resolve(firstOutput, first.fileNames.xpiManifest), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('\t').at(-1)),
    ).toEqual(['manifest.json', 'z.txt']);
    expect(
      readFileSync(
        resolve(firstOutput, first.fileNames.sourceManifest),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => line.split('\t').at(-1)),
    ).toEqual(['package.json', 'src/index.ts']);
    const receipt = JSON.parse(
      readFileSync(resolve(firstOutput, first.fileNames.receipt), 'utf8'),
    );
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      uploadable: true,
      extensionVersion: '0.8.1',
      runtime: receiptInputs.runtime,
      lockfileSha256: receiptInputs.lockfileSha256,
      modelPackage: {
        version: receiptInputs.modelManifestVersion,
        manifestSha256: receiptInputs.modelManifestSha256,
        staticAssetManifestSha256:
          receiptInputs.staticAssetManifestSha256,
      },
      outputs: {
        firefoxXpi: {
          file: first.fileNames.xpi,
        },
        sourceArchive: {
          file: first.fileNames.source,
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(firstOutput);
    expect(JSON.stringify(receipt)).not.toContain(secondOutput);
    expect(first.receipt).toEqual(second.receipt);
  });

  it('warns at 190,000,000 bytes and hard-fails at 200,000,000 bytes independently per archive', () => {
    const warnings: string[] = [];
    enforceAmoArchiveSize({
      label: 'Firefox XPI',
      bytes: 189_999_999,
      warn: (message) => warnings.push(message),
    });
    enforceAmoArchiveSize({
      label: 'Firefox XPI',
      bytes: 190_000_000,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'Firefox XPI is 190000000 bytes',
      ),
    ]);
    expect(() =>
      enforceAmoArchiveSize({
        label: 'AMO source archive',
        bytes: 200_000_000,
        warn: (message) => warnings.push(message),
      }),
    ).toThrow('200000000 byte AMO hard limit');
    expect(warnings).toHaveLength(1);
  });
});
