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
const ortRuntimeModulePaths = [
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.mjs',
];
const ortRuntimeWasmPaths = [
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
  'ort/ort-wasm-simd-threaded.wasm',
];
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
  for (const path of ortRuntimeModulePaths) {
    writeArtifact(
      directory,
      path,
      'export default function ortWasmThreaded() {}\n',
    );
  }
  for (const path of ortRuntimeWasmPaths) {
    writeArtifact(directory, path);
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
    'rejects a const dynamic import whose artifact is missing',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'popup.js',
        [
          'const modulePath = "./chunks/missing-const.js";',
          'const alias = modulePath;',
          'import(alias);',
        ].join('\n'),
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Artifact popup.js references missing artifact: chunks/missing-const.js',
      );
    },
    15_000,
  );

  it(
    'rejects concatenated and template dynamic imports whose artifacts are missing',
    () => {
      const cases = [
        {
          source:
            'import("./chunks/" + "missing-concatenated.js");\n',
          missingPath: 'chunks/missing-concatenated.js',
        },
        {
          source: 'import(`./chunks/missing-template.js`);\n',
          missingPath: 'chunks/missing-template.js',
        },
      ];

      for (const invalidCase of cases) {
        const directory = createReleaseFixture('chrome');
        writeArtifact(
          directory,
          'popup.js',
          invalidCase.source,
        );

        const result = runReleaseBoundary('chrome', directory);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `Artifact popup.js references missing artifact: ${invalidCase.missingPath}`,
        );
      }
    },
    20_000,
  );

  it(
    'rejects a dynamic import that cannot be statically resolved',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'popup.js',
        [
          'const modulePath = getRuntimeModulePath();',
          'import(modulePath);',
        ].join('\n'),
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Artifact popup.js contains dynamic import that cannot be statically resolved at 2:1.',
      );
    },
    15_000,
  );

  it(
    'rejects dynamic imports shadowed by runtime bindings',
    () => {
      const cases = [
        [
          'const modulePath = "./chunks/config.js";',
          'try {',
          '  throw getRuntimeModulePath();',
          '} catch (modulePath) {',
          '  import(modulePath);',
          '}',
        ].join('\n'),
        [
          'const modulePath = "./chunks/config.js";',
          'for (const modulePath of getRuntimeModulePaths()) {',
          '  import(modulePath);',
          '}',
        ].join('\n'),
        [
          'const modulePath = "./chunks/config.js";',
          'const load = function modulePath() {',
          '  import(modulePath);',
          '};',
          'load();',
        ].join('\n'),
      ];

      for (const source of cases) {
        const directory = createReleaseFixture('chrome');
        writeArtifact(directory, 'popup.js', source);

        const result = runReleaseBoundary('chrome', directory);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'Artifact popup.js contains dynamic import that cannot be statically resolved at',
        );
      }
    },
    20_000,
  );

  it(
    'rejects dynamic imports through a shadowed chrome runtime',
    () => {
      const cases = [
        [
          'const chrome = {',
          '  runtime: { getURL: getRuntimeModulePath },',
          '};',
          'import(chrome.runtime.getURL("chunks/config.js"));',
        ].join('\n'),
        [
          'function loadRuntimeModule(chrome) {',
          '  return import(',
          '    chrome.runtime.getURL("chunks/config.js"),',
          '  );',
          '}',
        ].join('\n'),
      ];

      for (const source of cases) {
        const directory = createReleaseFixture('chrome');
        writeArtifact(directory, 'popup.js', source);

        const result = runReleaseBoundary('chrome', directory);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'Artifact popup.js contains dynamic import that cannot be statically resolved at',
        );
      }
    },
    20_000,
  );

  it(
    'accepts statically resolvable dynamic imports',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'popup.js',
        [
          'import("./chunks/config.js");',
          'const chunkName = "onnxWorker";',
          'const modulePath = "./chunks/" + chunkName + "Bridge.js";',
          'import(modulePath);',
          'import(`./chunks/diagnosticLog.js`);',
          'import(chrome.runtime.getURL("chunks/messages.js"));',
        ].join('\n'),
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status, result.stderr).toBe(0);
    },
    15_000,
  );

  it(
    'rejects a const getURL resource that is not web-accessible',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'content.js',
        [
          'const runtimePath = "background.js";',
          'const alias = runtimePath;',
          'import(chrome.runtime.getURL(alias));',
        ].join('\n'),
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Content script runtime resource is not declared web-accessible: background.js',
      );
    },
    15_000,
  );

  it(
    'rejects a single-quoted getURL resource that is not web-accessible',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'content.js',
        "chrome.runtime.getURL('background.js');\n",
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Content script runtime resource is not declared web-accessible: background.js',
      );
    },
    15_000,
  );

  it(
    'rejects concatenated and template getURL resources that are not web-accessible',
    () => {
      const cases = [
        'chrome.runtime.getURL("back" + "ground.js");\n',
        'chrome.runtime.getURL(`background.js`);\n',
      ];

      for (const source of cases) {
        const directory = createReleaseFixture('chrome');
        writeArtifact(directory, 'content.js', source);

        const result = runReleaseBoundary('chrome', directory);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'Content script runtime resource is not declared web-accessible: background.js',
        );
      }
    },
    20_000,
  );

  it(
    'accepts declared getURL resources without treating ordinary imports as exposed',
    () => {
      const cases = [
        [
          "const runtimePath = 'chunks/config.js';",
          'import(chrome.runtime.getURL(runtimePath));',
        ].join('\n'),
        'import("./background.js");\n',
      ];

      for (const source of cases) {
        const directory = createReleaseFixture('chrome');
        writeArtifact(directory, 'content.js', source);

        const result = runReleaseBoundary('chrome', directory);

        expect(result.status, result.stderr).toBe(0);
      }
    },
    20_000,
  );

  it(
    'rejects a getURL resource that cannot be statically resolved',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        'content.js',
        'chrome.runtime.getURL(getRuntimeModulePath());\n',
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Artifact content.js contains chrome.runtime.getURL reference that cannot be statically resolved at 1:1.',
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
    'rejects an ORT runtime module without its default factory export',
    () => {
      const directory = createReleaseFixture('chrome');
      writeArtifact(
        directory,
        ortRuntimeModulePaths[0],
        'void 0;\n',
      );

      const result = runReleaseBoundary('chrome', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `ORT runtime module must export a default factory: ${ortRuntimeModulePaths[0]}`,
      );
    },
    15_000,
  );

  it(
    'rejects a missing ORT runtime WASM dependency',
    () => {
      const directory = createReleaseFixture('firefox');
      unlinkSync(join(directory, ortRuntimeWasmPaths[0]));

      const result = runReleaseBoundary('firefox', directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `Release build is missing required artifact: ${ortRuntimeWasmPaths[0]}`,
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
