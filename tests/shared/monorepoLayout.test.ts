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
};

type ExtensionManifest = {
  version: string;
  manifest_version: number;
};

describe('monorepo application ownership', () => {
  it('keeps the extension release shell inside apps/extension', () => {
    for (const path of [
      'apps/extension/package.json',
      'apps/extension/tsconfig.json',
      'apps/extension/vite.config.ts',
      'apps/extension/popup.html',
      'apps/extension/offscreen.html',
      'apps/extension/benchmark.html',
      'apps/extension/public/manifest.json',
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
    ]) {
      expect(existsSync(pathFromRoot(legacyRootPath)), legacyRootPath).toBe(false);
    }
  });

  it('delegates extension commands to the workspace and keeps versions aligned', () => {
    const rootPackage = readJson<PackageManifest>('package.json');
    const extensionPackage = readJson<PackageManifest>('apps/extension/package.json');
    const extensionManifest = readJson<ExtensionManifest>(
      'apps/extension/public/manifest.json',
    );

    expect(rootPackage.workspaces).toContain('apps/*');
    expect(extensionPackage.name).toBe('@shinobu/extension');
    expect(rootPackage.scripts?.['dev:extension']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.['build:extension']).toContain(
      '--workspace=@shinobu/extension',
    );
    expect(rootPackage.scripts?.build).toBe('npm run build:extension');
    expect(extensionManifest.manifest_version).toBe(3);
    expect(extensionManifest.version).toBe(extensionPackage.version);
  });
});
