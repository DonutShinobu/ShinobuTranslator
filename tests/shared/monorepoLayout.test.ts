import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('monorepo application ownership', () => {
  it('ratchets workspace import boundaries through the root check command', () => {
    for (const path of [
      'scripts/check-workspace-import-boundaries.mjs',
      'scripts/workspace-import-boundary-baseline.json',
    ]) {
      expect(existsSync(pathFromRoot(path)), path).toBe(true);
    }

    const rootPackage = readJson<PackageManifest>('package.json');
    expect(rootPackage.scripts?.['check:architecture']).toBe(
      'node scripts/check-workspace-import-boundaries.mjs',
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
      'apps/extension/benchmark.html',
      'apps/extension/manifest/common.json',
      'apps/extension/manifest/targets/chrome.json',
      'apps/extension/manifest/targets/firefox.json',
      'apps/extension/scripts/build.mjs',
      'apps/extension/scripts/generate-manifest.mjs',
      'apps/extension/scripts/check-artifacts.mjs',
      'apps/extension/scripts/check-release-boundaries.mjs',
      'apps/extension/src/background.ts',
      'apps/extension/src/content.ts',
      'apps/extension/src/popup.tsx',
      'apps/extension/src/offscreen.ts',
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
      'apps/extension/public/manifest.json',
    ]) {
      expect(existsSync(pathFromRoot(legacyRootPath)), legacyRootPath).toBe(false);
    }
  });

  it('delegates isolated extension target builds to one workspace builder', () => {
    const rootPackage = readJson<PackageManifest>('package.json');
    const extensionPackage = readJson<PackageManifest>('apps/extension/package.json');

    expect(rootPackage.workspaces).toContain('apps/*');
    expect(extensionPackage.name).toBe('@shinobu/extension');
    expect(rootPackage.scripts?.['dev:extension']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.['build:extension']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.build).toBe('npm run build:extension');
    expect(extensionPackage.scripts?.build).toBe(
      'npm run typecheck && node scripts/build.mjs',
    );
    expect(extensionPackage.scripts?.['build:chrome']).toContain(
      'build.mjs --target chrome',
    );
    expect(extensionPackage.scripts?.['build:firefox']).toContain(
      'build.mjs --target firefox',
    );
    expect(extensionPackage.scripts?.['build:benchmark']).toContain(
      'build.mjs --target benchmark',
    );
    expect(rootPackage.scripts?.['check:artifacts']).toBe(
      'npm run check:artifacts --workspace=@shinobu/extension',
    );
    expect(extensionPackage.scripts?.['check:artifacts']).toBe(
      'node scripts/check-artifacts.mjs',
    );
  });
});
