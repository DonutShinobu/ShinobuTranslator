import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExtensionManifest } from '../../apps/extension/manifest';

const root = process.cwd();
const pathFromRoot = (path: string): string => resolve(root, path);
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(pathFromRoot(path), 'utf8')) as T;

type PackageManifest = {
  name: string;
  version: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

type ExtensionManifest = {
  version: string;
  manifest_version: number;
};

describe('monorepo application ownership', () => {
  it('ratchets workspace import boundaries through the root check command', () => {
    for (const path of [
      'scripts/check-workspace-import-boundaries.mjs',
      'scripts/workspace-import-boundary-baseline.json',
    ]) {
      expect(existsSync(pathFromRoot(path)), path).toBe(true);
    }

    const rootPackage = readJson<PackageManifest>('package.json');
    expect(rootPackage.scripts?.['check:architecture']).toContain(
      'node scripts/check-workspace-import-boundaries.mjs',
    );
    expect(rootPackage.scripts?.['check:architecture']).toContain(
      'node scripts/check-extension-architecture.mjs',
    );
    expect(rootPackage.scripts?.check).toContain('npm run check:architecture');
  });

  it('keeps the shared image pipeline behind its package boundary', () => {
    for (const path of [
      'packages/image-pipeline/package.json',
      'packages/image-pipeline/tsconfig.json',
      'packages/image-pipeline/src/index.ts',
    ]) {
      expect(existsSync(pathFromRoot(path)), path).toBe(true);
    }

    const imagePipeline = readJson<PackageManifest>(
      'packages/image-pipeline/package.json',
    );
    expect(imagePipeline.name).toBe('@shinobu/image-pipeline');
    expect(imagePipeline.dependencies).toEqual({
      '@shinobu/diagnostics': '0.1.0',
      '@shinobu/model-runtime': '0.1.0',
      '@shinobu/text-translation': '0.1.0',
      '@shinobu/translator-core': '0.1.0',
    });
  });

  it('keeps the extension release shell inside apps/extension', () => {
    for (const path of [
      'apps/extension/package.json',
      'apps/extension/tsconfig.json',
      'apps/extension/vite.config.ts',
      'apps/extension/popup.html',
      'apps/extension/offscreen.html',
      'apps/extension/background-firefox.html',
      'apps/extension/benchmark.html',
      'apps/extension/manifest.ts',
      'apps/extension/src/popup.tsx',
      'apps/extension/src/offscreen.ts',
      'apps/extension/src/background-firefox.ts',
      'apps/extension/src/benchmark.ts',
    ]) {
      expect(existsSync(pathFromRoot(path)), path).toBe(true);
    }

    for (const legacyRootPath of [
      'vite.config.ts',
      'popup.html',
      'offscreen.html',
      'benchmark.html',
      'public/manifest.json',
    ]) {
      expect(existsSync(pathFromRoot(legacyRootPath)), legacyRootPath).toBe(false);
    }
  });

  it('delegates extension commands to the workspace and keeps versions aligned', () => {
    const rootPackage = readJson<PackageManifest>('package.json');
    const extensionPackage = readJson<PackageManifest>('apps/extension/package.json');
    const chromiumManifest = createExtensionManifest(
      'chromium',
      extensionPackage.version,
    ) as ExtensionManifest;
    const firefoxManifest = createExtensionManifest(
      'firefox',
      extensionPackage.version,
    ) as ExtensionManifest;

    expect(rootPackage.workspaces).toContain('apps/*');
    expect(extensionPackage.name).toBe('@shinobu/extension');
    expect(rootPackage.scripts?.['dev:extension:chromium']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.['build:extension']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.build).toBe('npm run build:extension');
    expect(chromiumManifest.manifest_version).toBe(3);
    expect(firefoxManifest.manifest_version).toBe(3);
    expect(chromiumManifest.version).toBe(extensionPackage.version);
    expect(firefoxManifest.version).toBe(extensionPackage.version);
  });
});
