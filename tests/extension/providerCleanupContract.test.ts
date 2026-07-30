import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoRemoteDetectionFallbackResources,
} from '../../apps/extension/scripts/detection-resource-boundary.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];

function makePackageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shinobu-detection-boundary-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('legacy detector removal contract', () => {
  it('keeps Tesseract out of production dependencies, licenses, and source', () => {
    const rootPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const extensionPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps/extension/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const lockfile = readFileSync(
      join(repositoryRoot, 'package-lock.json'),
      'utf8',
    );
    const licenseInventory = readFileSync(
      join(repositoryRoot, 'THIRD_PARTY_DEPENDENCIES.json'),
      'utf8',
    );
    const detectorSource = readFileSync(
      join(repositoryRoot, 'src/pipeline/detect/index.ts'),
      'utf8',
    );

    expect(rootPackage.dependencies).not.toHaveProperty('tesseract.js');
    expect(extensionPackage.dependencies).not.toHaveProperty('tesseract.js');
    expect(lockfile).not.toMatch(/tesseract(?:\.js|-core)/iu);
    expect(licenseInventory).not.toMatch(/tesseract(?:\.js|-core)/iu);
    expect(detectorSource).not.toMatch(/tesseract|heuristic/iu);
  });

  it('keeps provider and OCR test controls out of global variables', () => {
    const productionSource = [
      'src/pipeline/ocr/paddleocrProvider.ts',
      'src/runtime/modelRegistry.ts',
      'src/workers/onnx-worker.ts',
    ].map((relativePath) =>
      readFileSync(join(repositoryRoot, relativePath), 'utf8')).join('\n');

    expect(productionSource).not.toMatch(/__shinobuPaddleOcr/iu);
    expect(productionSource).not.toMatch(
      /preferred\??:\s*(?:readonly\s+)?RuntimeProvider\[\]/u,
    );
  });

  it('accepts a package containing only the local ONNX worker', () => {
    const directory = makePackageDirectory();
    writeFileSync(
      join(directory, 'onnxWorker.js'),
      'const workerUrl = chrome.runtime.getURL("onnxWorker.js");',
    );

    expect(() =>
      assertNoRemoteDetectionFallbackResources(directory)).not.toThrow();
  });

  it('rejects Tesseract artifacts and remote executable resource URLs', () => {
    const artifactDirectory = makePackageDirectory();
    mkdirSync(join(artifactDirectory, 'vendor'));
    writeFileSync(
      join(artifactDirectory, 'vendor', 'tesseract-core.wasm'),
      'legacy wasm',
    );

    expect(() =>
      assertNoRemoteDetectionFallbackResources(artifactDirectory)).toThrow(
      /Tesseract/iu,
    );

    const remoteDirectory = makePackageDirectory();
    writeFileSync(
      join(remoteDirectory, 'background.js'),
      'const workerPath = "https://cdn.example.test/detector-worker.js";',
    );

    expect(() =>
      assertNoRemoteDetectionFallbackResources(remoteDirectory)).toThrow(
      /remote executable/iu,
    );
  });
});
