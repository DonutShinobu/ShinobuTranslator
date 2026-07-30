import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const generatorPath = resolve(
  root,
  'apps/extension/scripts/generate-manifest.mjs',
);
const releaseBoundaryPath = resolve(
  root,
  'apps/extension/scripts/check-release-boundaries.mjs',
);
const temporaryDirectories: string[] = [];

function writeArtifact(
  directory: string,
  path: string,
  contents = '',
): void {
  const outputPath = join(directory, path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
}

function createReleaseFixture(target: 'chrome' | 'firefox'): string {
  const directory = mkdtempSync(
    join(tmpdir(), `shinobu-${target}-release-boundary-`),
  );
  temporaryDirectories.push(directory);
  execFileSync(
    process.execPath,
    [
      generatorPath,
      '--target',
      target,
      '--output',
      join(directory, 'manifest.json'),
    ],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );

  const commonArtifacts = [
    'popup.html',
    'popup.js',
    'background.js',
    'content.js',
    'onnxWorker.js',
    'chunks/messages.js',
    'chunks/localPipelineProtocol.js',
    'chunks/chromeAdapter.js',
    'chunks/config.js',
    'chunks/diagnosticLog.js',
    'chunks/diagnosticLogClient.js',
    'chunks/diagnosticPrimitives.js',
    'chunks/perfTrace.js',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'fonts/SourceHanSansCN-VF.ttf.woff2',
    'assets/popup.css',
  ];
  for (const path of commonArtifacts) {
    writeArtifact(
      directory,
      path,
      path.endsWith('.js') ? 'void 0;\n' : '',
    );
  }
  writeArtifact(
    directory,
    'popup.html',
    [
      '<script type="module" src="/popup.js"></script>',
      '<link rel="stylesheet" href="/assets/popup.css">',
    ].join('\n'),
  );
  writeArtifact(
    directory,
    'content.js',
    'chrome.runtime.getURL("chunks/config.js");\n',
  );
  if (target === 'chrome') {
    writeArtifact(directory, 'offscreen.html');
    writeArtifact(directory, 'offscreen.js', 'void 0;\n');
    writeArtifact(
      directory,
      'chunks/modulepreload-polyfill.js',
      'void 0;\n',
    );
    writeArtifact(
      directory,
      'popup.js',
      'import "./chunks/modulepreload-polyfill.js";\n',
    );
    writeArtifact(
      directory,
      'chunks/onnxWorkerBridge.js',
      'void 0;\n',
    );
  }
  return directory;
}

function runReleaseBoundary(
  target: 'chrome' | 'firefox',
  directory: string,
) {
  return spawnSync(
    process.execPath,
    [
      releaseBoundaryPath,
      '--target',
      target,
      '--dist',
      directory,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
}

function rewriteManifest(
  directory: string,
  mutate: (manifest: Record<string, any>) => void,
  trailing = '',
): void {
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as Record<string, any>;
  mutate(manifest);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n${trailing}`,
    'utf8',
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('extension release boundaries', () => {
  it(
    'rejects a manifest reference whose artifact is missing',
    () => {
      const cases = [
        {
          target: 'chrome' as const,
          path: 'icons/icon128.png',
          error:
            'Manifest reference action.default_icon.128 is missing artifact: icons/icon128.png',
        },
        {
          target: 'chrome' as const,
          path: 'chunks/config.js',
          error:
            'Manifest resource web_accessible_resources[0].resources[3] matches no packaged artifact: chunks/config.js',
        },
        {
          target: 'chrome' as const,
          path: 'chunks/modulepreload-polyfill.js',
          error:
            'Artifact popup.js references missing artifact: chunks/modulepreload-polyfill.js',
        },
        {
          target: 'chrome' as const,
          path: 'assets/popup.css',
          error:
            'Artifact popup.html references missing artifact: assets/popup.css',
        },
        {
          target: 'firefox' as const,
          path: 'chunks/diagnosticLogClient.js',
          error:
            'Manifest resource web_accessible_resources[0].resources[5] matches no packaged artifact: chunks/diagnosticLogClient.js',
        },
      ];

      for (const invalidCase of cases) {
        const directory = createReleaseFixture(invalidCase.target);
        unlinkSync(join(directory, invalidCase.path));

        const result = runReleaseBoundary(
          invalidCase.target,
          directory,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(invalidCase.error);
      }
    },
    30_000,
  );

  it(
    'rejects a literal dynamic import whose artifact is missing',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'popup.js',
        'import("./chunks/missing-dynamic.js");\n',
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Artifact popup.js references missing artifact: chunks/missing-dynamic.js',
      );
    },
    15_000,
  );

  it(
    'rejects a literal dynamic import outside the packaged graph',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'popup.js',
        'import("node:fs");\n',
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Artifact popup.js contains non-packaged reference: node:fs',
      );
    },
    15_000,
  );

  it(
    'rejects a web-accessible wildcard that exposes a private runtime artifact',
    () => {
      const directory = createReleaseFixture('chrome');
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(
        readFileSync(manifestPath, 'utf8'),
      ) as {
        web_accessible_resources: Array<{
          resources: string[];
          matches: string[];
        }>;
      };
      manifest.web_accessible_resources[0].resources = ['*'];
      writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Manifest resource web_accessible_resources[0].resources[0] exposes private artifact background.js: *',
      );
    },
    15_000,
  );

  it(
    'rejects benchmark and test-control assets from store products',
    () => {
      const cases = [
        {
          path: 'benchmark-chunks/driver.js',
          error:
            'Release build contains benchmark-only artifact: benchmark-chunks',
        },
        {
          path: 'benchmark/driver.js',
          error:
            'Release build contains benchmark-only artifact: benchmark/driver.js',
        },
        {
          path: 'test-controls/fault-injection.js',
          error:
            'Release build contains test-control artifact: test-controls/fault-injection.js',
        },
        {
          path: 'test-control.js',
          error:
            'Release build contains test-control artifact: test-control.js',
        },
      ];

      for (const invalidCase of cases) {
        const directory = createReleaseFixture('firefox');
        writeArtifact(directory, invalidCase.path, 'void 0;\n');

        const result = runReleaseBoundary('firefox', directory);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(invalidCase.error);
      }

      const markedDirectory = createReleaseFixture('firefox');
      writeArtifact(
        markedDirectory,
        'assets/control.json',
        '{"control":"__shinobu_test_control"}\n',
      );
      const markedResult = runReleaseBoundary(
        'firefox',
        markedDirectory,
      );
      expect(markedResult.status).not.toBe(0);
      expect(markedResult.stderr).toContain(
        'Release artifact contains forbidden test-control token __shinobu_test_control: assets/control.json',
      );

      const undeclaredDirectory = createReleaseFixture('firefox');
      writeArtifact(
        undeclaredDirectory,
        'assets/release-helper.json',
        '{}\n',
      );
      const undeclaredResult = runReleaseBoundary(
        'firefox',
        undeclaredDirectory,
      );
      expect(undeclaredResult.status).not.toBe(0);
      expect(undeclaredResult.stderr).toContain(
        'Release build contains artifact outside the firefox store boundary: assets/release-helper.json',
      );
    },
    30_000,
  );

  it(
    'enforces MV3, exact CSP, and target-exclusive manifest fields',
    () => {
      const cases: Array<{
        target: 'chrome' | 'firefox';
        mutate: (manifest: Record<string, any>) => void;
        error: string;
      }> = [
        {
          target: 'chrome',
          mutate: (manifest) => {
            manifest.manifest_version = 2;
          },
          error: 'Release manifest must use Manifest V3.',
        },
        {
          target: 'chrome',
          mutate: (manifest) => {
            manifest.content_security_policy.extension_pages +=
              " script-src https://example.test 'unsafe-eval';";
          },
          error:
            'Release manifest CSP must exactly match the declarative specification.',
        },
        {
          target: 'chrome',
          mutate: (manifest) => {
            manifest.browser_specific_settings = {
              gecko: { id: 'forbidden@example.test' },
            };
          },
          error:
            'Chrome manifest must not contain Gecko-specific browser_specific_settings.',
        },
        {
          target: 'firefox',
          mutate: (manifest) => {
            manifest.background.service_worker = 'background.js';
          },
          error:
            'Firefox manifest must not contain background.service_worker.',
        },
        {
          target: 'firefox',
          mutate: (manifest) => {
            manifest.minimum_chrome_version = '109';
          },
          error:
            'Firefox manifest must not contain minimum_chrome_version.',
        },
        {
          target: 'firefox',
          mutate: (manifest) => {
            manifest.permissions.push('offscreen');
          },
          error:
            'Firefox manifest must not request the offscreen permission.',
        },
      ];

      for (const invalidCase of cases) {
        const directory = createReleaseFixture(invalidCase.target);
        rewriteManifest(directory, invalidCase.mutate);

        const result = runReleaseBoundary(
          invalidCase.target,
          directory,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(invalidCase.error);
      }
    },
    30_000,
  );

  it(
    'accepts exact Chrome and Firefox artifacts and rejects byte-only manifest drift',
    () => {
      for (const target of ['chrome', 'firefox'] as const) {
        const directory = createReleaseFixture(target);
        const result = runReleaseBoundary(target, directory);
        expect(result.status).toBe(0);
      }

      const driftedDirectory = createReleaseFixture('chrome');
      rewriteManifest(driftedDirectory, () => {}, '\n');
      const driftedResult = runReleaseBoundary(
        'chrome',
        driftedDirectory,
      );

      expect(driftedResult.status).not.toBe(0);
      expect(driftedResult.stderr).toContain(
        'chrome manifest does not byte-match the declarative source and extension workspace version.',
      );
    },
    20_000,
  );
});
