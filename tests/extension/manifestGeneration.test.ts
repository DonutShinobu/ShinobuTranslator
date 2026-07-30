import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const generatorPath = resolve(
  root,
  'apps/extension/scripts/generate-manifest.mjs',
);
const pairCheckerPath = resolve(
  root,
  'apps/extension/scripts/check-manifest-pair.mjs',
);
const extensionBuilderPath = resolve(
  root,
  'apps/extension/scripts/build.mjs',
);
const commonSourcePath = resolve(
  root,
  'apps/extension/manifest/common.json',
);
const extensionPackagePath = resolve(root, 'apps/extension/package.json');
const temporaryDirectories: string[] = [];

function generate(target: 'chrome' | 'firefox'): {
  bytes: string;
  manifest: Record<string, unknown>;
  outputPath: string;
} {
  const outputDirectory = mkdtempSync(
    join(tmpdir(), 'shinobu-manifest-generation-'),
  );
  temporaryDirectories.push(outputDirectory);
  const outputPath = join(outputDirectory, 'manifest.json');
  execFileSync(
    process.execPath,
    [
      generatorPath,
      '--target',
      target,
      '--output',
      outputPath,
    ],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );
  const bytes = readFileSync(outputPath, 'utf8');
  return {
    bytes,
    manifest: JSON.parse(bytes) as Record<string, unknown>,
    outputPath,
  };
}

function makeTemporaryJson(
  name: string,
  value: Record<string, unknown>,
): string {
  const directory = mkdtempSync(
    join(tmpdir(), 'shinobu-manifest-fixture-'),
  );
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('extension manifest generation', () => {
  it('generates the deterministic Chrome 109 manifest from the extension workspace version', () => {
    const commonSource = JSON.parse(
      readFileSync(commonSourcePath, 'utf8'),
    ) as Record<string, unknown>;
    const extensionPackage = JSON.parse(
      readFileSync(extensionPackagePath, 'utf8'),
    ) as { version: string };

    expect(commonSource).not.toHaveProperty('version');

    const first = generate('chrome');
    const second = generate('chrome');

    expect(second.bytes).toBe(first.bytes);
    expect(first.manifest).toMatchObject({
      manifest_version: 3,
      version: extensionPackage.version,
      minimum_chrome_version: '109',
      background: {
        service_worker: 'background.js',
        type: 'module',
      },
      content_security_policy: {
        extension_pages:
          "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
      },
    });
    expect(first.manifest.permissions).toEqual([
      'contextMenus',
      'cookies',
      'declarativeNetRequest',
      'offscreen',
      'storage',
      'tabs',
      'webRequest',
    ]);
    expect(first.manifest).not.toHaveProperty('browser_specific_settings');
    expect(first.manifest).not.toHaveProperty('optional_permissions');
  });

  it('generates the Firefox 140 module event page with declared data and optional cookie permissions', () => {
    const generated = generate('firefox');

    expect(generated.manifest).toMatchObject({
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      browser_specific_settings: {
        gecko: {
          id: 'shinobu-translator@donutshinobu',
          strict_min_version: '140.0',
          data_collection_permissions: {
            required: ['websiteContent'],
            optional: ['authenticationInfo'],
          },
        },
      },
      content_security_policy: {
        extension_pages:
          "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
      },
    });
    expect(generated.manifest.permissions).toEqual([
      'contextMenus',
      'declarativeNetRequest',
      'storage',
      'tabs',
      'webRequest',
    ]);
    expect(generated.manifest.optional_permissions).toEqual(['cookies']);
    expect(generated.manifest).not.toHaveProperty('minimum_chrome_version');
    expect(generated.manifest.permissions).not.toContain('offscreen');
    expect(generated.manifest.permissions).not.toContain('cookies');
    expect(generated.manifest.background).not.toHaveProperty('service_worker');
  });

  it('rejects common and target source properties outside the whitelist schema', () => {
    const common = JSON.parse(
      readFileSync(commonSourcePath, 'utf8'),
    ) as Record<string, unknown>;
    const chromeTargetPath = resolve(
      root,
      'apps/extension/manifest/targets/chrome.json',
    );
    const chromeTarget = JSON.parse(
      readFileSync(chromeTargetPath, 'utf8'),
    ) as Record<string, unknown>;

    const cases = [
      {
        argument: '--common',
        path: makeTemporaryJson('common.json', {
          ...common,
          version: '9.9.9',
        }),
        error: 'unknown property "version"',
      },
      {
        argument: '--target-source',
        path: makeTemporaryJson('chrome.json', {
          ...chromeTarget,
          manifestPatch: {
            permissions: ['history'],
          },
        }),
        error: 'unknown property "manifestPatch"',
      },
      {
        argument: '--target-source',
        path: makeTemporaryJson('chrome-remove.json', {
          ...chromeTarget,
          permission_overrides: {
            ...(chromeTarget.permission_overrides as Record<string, unknown>),
            required: {
              add: ['offscreen', 'cookies'],
              remove: ['tabs'],
            },
          },
        }),
        error:
          'target.permission_overrides.required.remove: expected exactly []',
      },
    ];

    for (const invalidCase of cases) {
      const outputDirectory = mkdtempSync(
        join(tmpdir(), 'shinobu-invalid-manifest-output-'),
      );
      temporaryDirectories.push(outputDirectory);
      const result = spawnSync(
        process.execPath,
        [
          generatorPath,
          '--target',
          'chrome',
          '--output',
          join(outputDirectory, 'manifest.json'),
          invalidCase.argument,
          invalidCase.path,
        ],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(invalidCase.error);
    }
  });

  it('does not allow the extension workspace version source to be overridden', () => {
    const outputDirectory = mkdtempSync(
      join(tmpdir(), 'shinobu-version-source-'),
    );
    temporaryDirectories.push(outputDirectory);
    const result = spawnSync(
      process.execPath,
      [
        generatorPath,
        '--target',
        'chrome',
        '--output',
        join(outputDirectory, 'manifest.json'),
        '--package',
        resolve(root, 'packages/image-pipeline/package.json'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'manifest version always comes from apps/extension/package.json',
    );
  });

  it('accepts only the declared Chrome and Firefox manifest differences', () => {
    const chrome = generate('chrome');
    const firefox = generate('firefox');

    expect(() => {
      execFileSync(
        process.execPath,
        [
          pairCheckerPath,
          '--chrome',
          chrome.outputPath,
          '--firefox',
          firefox.outputPath,
        ],
        {
          cwd: root,
          stdio: 'pipe',
        },
      );
    }).not.toThrow();

    const changedFirefoxPath = makeTemporaryJson('manifest.json', {
      ...firefox.manifest,
      description: 'undeclared target-specific description',
    });
    const changedResult = spawnSync(
      process.execPath,
      [
        pairCheckerPath,
        '--chrome',
        chrome.outputPath,
        '--firefox',
        changedFirefoxPath,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(changedResult.status).not.toBe(0);
    expect(changedResult.stderr).toContain(
      'undeclared target manifest difference at description',
    );
  });

  it('assigns isolated release directories and a Chrome-only non-release benchmark target', () => {
    const description = execFileSync(
      process.execPath,
      [extensionBuilderPath, '--describe-targets'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    expect(JSON.parse(description)).toEqual({
      chrome: {
        browser: 'chrome',
        manifestTarget: 'chrome',
        outDir: 'apps/extension/dist/chrome',
        release: true,
      },
      firefox: {
        browser: 'firefox',
        manifestTarget: 'firefox',
        outDir: 'apps/extension/dist/firefox',
        release: true,
      },
      benchmark: {
        browser: 'chrome',
        manifestTarget: 'chrome',
        outDir: 'apps/extension/dist/benchmark',
        release: false,
      },
    });
  });
});
