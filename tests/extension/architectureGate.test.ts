import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findFrozenMigrationEdgeViolations,
  findSourcePolicyViolations,
  frozenExtensionMigrationEdgeKeys,
  frozenExtensionMigrationRemovalCondition,
  scanExtensionArchitecture,
} from '../../scripts/extension-architecture-policy.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const frozenMigrationFiles = [
  {
    relativePath: 'apps/extension/src/background.ts',
    source: [
      "import { startBackground } from '../../../src/background/index';",
      'const nativeChrome = globalThis.chrome;',
      'startBackground(nativeChrome);',
    ].join('\n'),
  },
  {
    relativePath: 'apps/extension/src/content.ts',
    source: [
      "import { startContent } from '../../../src/content/index';",
      'const nativeChrome = globalThis.chrome;',
      'startContent(nativeChrome);',
    ].join('\n'),
  },
];

describe('extension architecture gate', () => {
  it('allows native APIs only in adapters and target composition roots', () => {
    expect(findSourcePolicyViolations([
      {
        relativePath: 'apps/extension/src/capabilities/chromeRuntime.ts',
        source: 'chrome.runtime.lastError',
      },
      {
        relativePath: 'apps/extension/src/background.ts',
        source: [
          "import { startBackground } from '../../../src/background/index';",
          'const nativeChrome = globalThis.chrome;',
        ].join('\n'),
      },
      {
        relativePath:
          'apps/extension/build/classicContentScriptAdapter.ts',
        source: 'chrome.runtime.getURL("content.js")',
      },
    ])).toEqual([]);
  });

  it.each([
    [
      'src/content/core/controller.ts',
      'globalThis.chrome.runtime.sendMessage({});',
      'native extension namespace access',
    ],
    [
      'src/background/bypass.ts',
      [
        'const root = globalThis;',
        'root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/windowBypass.ts',
      [
        'const root = window;',
        'root.browser.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/selfAliasChain.ts',
      [
        'const first = self;',
        'const second = first;',
        'second.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/assignedGlobalAlias.ts',
      [
        'let root;',
        'root = globalThis;',
        'root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/defaultGlobalAlias.ts',
      [
        'function send(root = window) {',
        '  root.browser.runtime.sendMessage({});',
        '}',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/assignedGlobalAliasChain.ts',
      [
        'let first;',
        'let second;',
        'first = self;',
        'second = first;',
        'second.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredGlobalAssignment.ts',
      [
        'let chrome;',
        '({ chrome } = globalThis);',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredSelfAlias.ts',
      [
        'const { self: root } = globalThis;',
        'root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredWindowAssignment.ts',
      [
        'let root;',
        '({ window: root } = globalThis);',
        'root.browser.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredNativeParameter.ts',
      [
        'function send({ chrome } = globalThis) {',
        '  chrome.runtime.sendMessage({});',
        '}',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredSelfParameter.ts',
      [
        'function send({ self: root } = globalThis) {',
        '  root.chrome.runtime.sendMessage({});',
        '}',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/destructuredWindowArrowParameter.ts',
      [
        'const send = ({ window: root } = globalThis) =>',
        '  root.browser.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'packages/browser-runtime/src/index.ts',
      'type Port = ChromePort;',
      'native extension API type',
    ],
    [
      'src/pipeline/resources.ts',
      'const url = "chrome-extension://models/detector.onnx";',
      'platform extension URL scheme',
    ],
    [
      'src/background/router.ts',
      'if (error.message.includes("Receiving end does not exist")) return;',
      'browser error text control flow',
    ],
    [
      'src/shared/config.ts',
      'if (target === "firefox") return fallback;',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/messages.ts',
      'const isFirefox = runtimeName === name;',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/indirectPlatform.ts',
      'const CHROME = "chrome"; if (target === CHROME) return fallback;',
      'browser-specific branch or brand',
    ],
    [
      'src/background/indirectError.ts',
      [
        'const disconnected = "Receiving end does not exist";',
        'if (message.includes(disconnected)) return;',
      ].join('\n'),
      'browser error text control flow',
    ],
    [
      'apps/extension/src/capabilities/contracts.ts',
      'chrome.runtime.sendMessage({});',
      'native extension namespace access',
    ],
    [
      'apps/extension/src/capabilities/contracts.ts',
      'const native = chrome; native.runtime.sendMessage({});',
      'native extension namespace access',
    ],
    [
      'apps/extension/src/capabilities/contracts.ts',
      "globalThis['chrome'].runtime.sendMessage({});",
      'native extension namespace access',
    ],
    [
      'apps/extension/src/capabilities/guards.ts',
      "Reflect.get(globalThis, 'chrome');",
      'native extension namespace access',
    ],
    [
      'apps/extension/src/capabilities/guards.ts',
      'const { runtime } = globalThis.chrome;',
      'native extension namespace access',
    ],
    [
      'apps/extension/vite.config.ts',
      'const resourceUrl = chrome.runtime.getURL("worker.js");',
      'native extension namespace access',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const input = {};',
        'input["chunks/diagnosticLogClient"] = resolve(',
        '    repoRoot,',
        '    "src/shared/diagnosticLogClient.ts",',
        ');',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import * as path from "node:path";',
        'const { resolve } = path;',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const input = resolve(repoRoot, "src/shared/x.ts");',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const { resolve: r } = path;',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = r(extensionRoot, "../..");',
        'const input = r(repoRoot, "src/shared/x.ts");',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = path.resolve(extensionRoot, "../..");',
        'function build({ resolve } = path) {',
        '  const input = resolve(repoRoot, "src/shared/x.ts");',
        '  return input;',
        '}',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = path.posix.resolve(extensionRoot, "../..");',
        'const input = path.posix.resolve(repoRoot, "src/shared/x.ts");',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/build/arbitraryEntryAdapter.ts',
      [
        'import { join } from "node:path";',
        'const extensionRoot = join(import.meta.dirname, "..");',
        'const repoRoot = join(extensionRoot, "../..");',
        'export const entry = join(repoRoot, "src/workers/arbitrary.ts");',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      'const input = "../../src/shared/diagnosticLogClient.ts";',
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      'const input = "src/shared/diagnosticLogClient.ts";',
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const buildRoot = repoRoot;',
        'const input = resolve(',
        '  buildRoot,',
        '  "src/shared/diagnosticLogClient.ts",',
        ');',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const prefix = "src";',
        'const target = prefix + "/shared/diagnosticLogClient.ts";',
        'const input = resolve(repoRoot, target);',
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        String.raw`const input = resolve(repoRoot, "src\\shared\\diagnosticLogClient.ts");`,
      ].join('\n'),
      'extension build entry cannot directly target root src/**',
    ],
    [
      'src/shared/chrome.ts',
      'export type ChromeLike = {};',
      'legacy Chrome-shaped WebExtension seam',
    ],
  ])(
    'rejects %s',
    (relativePath, source, expectedViolation) => {
      expect(findSourcePolicyViolations([
        { relativePath, source },
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(expectedViolation),
      ]));
    },
  );

  it('does not treat comments or user-facing browser text as control flow', () => {
    expect(findSourcePolicyViolations([
      {
        relativePath: 'src/shared/helpText.ts',
        source: [
          '// Chrome runtime.lastError and Firefox troubleshooting notes.',
          'const browserHelp = "Chrome browser troubleshooting";',
          'const errorHelp = "Receiving end does not exist";',
          'function label(browser: { name: string }) {',
          '  return browser.name;',
          '}',
        ].join('\n'),
      },
    ])).toEqual([]);
  });

  it('allows extension-owned build inputs under apps/extension', () => {
    expect(findSourcePolicyViolations([
      {
        relativePath: 'apps/extension/vite.config.ts',
        source: [
          'import { resolve } from "node:path";',
          'const extensionRoot = import.meta.dirname;',
          'const input = {',
          '  background: resolve(extensionRoot, "src/background.ts"),',
          '};',
        ].join('\n'),
      },
    ])).toEqual([]);
  });

  it('does not confuse a local resolve helper with node:path', () => {
    expect(findSourcePolicyViolations([
      {
        relativePath: 'apps/extension/vite.config.ts',
        source: [
          'function resolve(base, value) {',
          '  return { base, value };',
          '}',
          'const repoRoot = "labels-only";',
          'const input = {',
          '  diagnostics: resolve(repoRoot, "src/label.ts"),',
          '};',
        ].join('\n'),
      },
    ])).toEqual([]);
  });

  describe('frozen entry migration edges', () => {
    it('locks exactly the two approved source-to-target edges', () => {
      expect(frozenExtensionMigrationEdgeKeys).toEqual([
        'apps/extension/src/background.ts -> ../../../src/background/index',
        'apps/extension/src/content.ts -> ../../../src/content/index',
      ]);
      expect(
        findFrozenMigrationEdgeViolations(frozenMigrationFiles),
      ).toEqual([]);
    });

    it('fails closed when an approved edge disappears', () => {
      const violations = findFrozenMigrationEdgeViolations([
        frozenMigrationFiles[0],
      ]);
      expect(violations).toEqual(expect.arrayContaining([
        expect.stringContaining('content.ts'),
        expect.stringContaining('count must be exactly 2'),
      ]));
      expect(violations).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'remove the corresponding import, frozen policy record, and architecture tests',
        ),
      ]));
    });

    it('rejects target drift', () => {
      expect(findFrozenMigrationEdgeViolations([
        {
          ...frozenMigrationFiles[0],
          source:
            "import { startBackground } from '../../../src/background/router';",
        },
        frozenMigrationFiles[1],
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'only the two frozen background/content app-to-root migration edges',
        ),
        expect.stringContaining(
          'frozen migration edge to ../../../src/background/index',
        ),
      ]));
    });

    it('rejects a third app-to-root source edge', () => {
      expect(findFrozenMigrationEdgeViolations([
        ...frozenMigrationFiles,
        {
          relativePath: 'apps/extension/src/capabilities/helper.ts',
          source:
            "import '../../../../src/shared/config';",
        },
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'only the two frozen background/content app-to-root migration edges',
        ),
      ]));
    });

    it('rejects a third app-to-root edge hidden in an .mts helper', () => {
      expect(findFrozenMigrationEdgeViolations([
        ...frozenMigrationFiles,
        {
          relativePath:
            'apps/extension/src/capabilities/hiddenMigration.mts',
          source:
            "import '../../../../src/shared/config';",
        },
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'only the two frozen background/content app-to-root migration edges',
        ),
      ]));
    });

    it.each([
      [
        'dynamic import',
        [
          {
            ...frozenMigrationFiles[0],
            source:
              "void import('../../../src/background/index');",
          },
          frozenMigrationFiles[1],
        ],
        'forbid dynamic import',
      ],
      [
        'computed dynamic import',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/src/computedBootstrap.ts',
            source: 'void import(getLegacyTarget());',
          },
        ],
        'forbids dynamic module loading',
      ],
      [
        'Vite dynamic plugin import',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/vite.config.ts',
            source:
              'await import("../../scripts/legacyBuildPlugin");',
          },
        ],
        'dynamic extension build loading can hide',
      ],
      [
        'Vite computed plugin import',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/vite.config.ts',
            source: 'await import(getPluginPath());',
          },
        ],
        'dynamic extension build loading can hide',
      ],
      [
        'alias',
        [
          {
            ...frozenMigrationFiles[0],
            source:
              "import { startBackground } from '#legacy-background';",
          },
          frozenMigrationFiles[1],
        ],
        'aliases and virtual modules are forbidden',
      ],
      [
        'virtual module',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/src/virtualBootstrap.ts',
            source: "import 'virtual:legacy-background';",
          },
        ],
        'virtual module cannot hide',
      ],
      [
        'global bridge',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/src/globalBootstrap.ts',
            source: 'globalThis.__legacyRootBootstrap();',
          },
        ],
        'global bridge cannot hide',
      ],
      [
        'native namespace global bridge',
        [
          {
            ...frozenMigrationFiles[0],
            source: [
              "import { startBackground } from '../../../src/background/index';",
              'globalThis.chrome.__legacyRootBootstrap();',
            ].join('\n'),
          },
          frozenMigrationFiles[1],
        ],
        'global bridge cannot hide',
      ],
      [
        'service-worker global bridge',
        [
          ...frozenMigrationFiles,
          {
            relativePath:
              'apps/extension/src/pipelineHost/chromeLifecycle.ts',
            source: 'globalThis.clients.__legacyRootBootstrap();',
          },
        ],
        'global bridge cannot hide',
      ],
      [
        'non-root virtual alias',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/src/aliasBootstrap.ts',
            source: "import '#legacy-background';",
          },
        ],
        'virtual module cannot hide',
      ],
      [
        'Vite alias',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/vite.config.ts',
            source: [
              'export default {',
              '  resolve: {',
              "    alias: { '#legacy-background': '../../../src/background/index' },",
              '  },',
              '};',
            ].join('\n'),
          },
        ],
        'build alias can hide',
      ],
      [
        'Vite alias shorthand',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/vite.config.ts',
            source: 'export default { resolve: { alias } };',
          },
        ],
        'build alias can hide',
      ],
      [
        'Vite alias assignment',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/vite.config.ts',
            source:
              "config.resolve.alias = { '#legacy': '../../../src/background/index' };",
          },
        ],
        'build alias can hide',
      ],
      [
        'virtual build hook',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/build/legacyAdapter.ts',
            source: 'export function resolveId(id: string) { return id; }',
          },
        ],
        'virtual module hook can hide',
      ],
      [
        'virtual build property',
        [
          ...frozenMigrationFiles,
          {
            relativePath: 'apps/extension/build/legacyAdapter.ts',
            source:
              'export const plugin = { resolveId: (id: string) => id };',
          },
        ],
        'virtual module hook can hide',
      ],
      [
        'extension script virtual hook',
        [
          ...frozenMigrationFiles,
          {
            relativePath:
              'apps/extension/scripts/legacyBuildPlugin.mjs',
            source:
              'export const plugin = { resolveId: (id) => id };',
          },
        ],
        'virtual module hook can hide',
      ],
    ])('rejects a hidden %s bypass', (_label, files, expected) => {
      expect(findFrozenMigrationEdgeViolations(files)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(expected),
        ]),
      );
    });

    it('locks the Vite-imported root virtualizer to its exact implementation', async () => {
      const relativePath = 'scripts/vite-browser-runtime-boundary.ts';
      const source = await readFile(
        resolve(repositoryRoot, relativePath),
        'utf8',
      );
      expect(findFrozenMigrationEdgeViolations([
        ...frozenMigrationFiles,
        { relativePath, source },
      ])).toEqual([]);

      expect(findFrozenMigrationEdgeViolations([
        ...frozenMigrationFiles,
        {
          relativePath,
          source: `${source}\nexport const hidden = { alias: {} };`,
        },
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'trusted root build plugin changed outside its exact semantic lock',
        ),
      ]));
    });

    it('documents the mandatory removal condition in policy and ADR', async () => {
      expect(frozenExtensionMigrationRemovalCondition).toEqual({
        trigger:
          'background/content reachable closure is app-owned or consumed through formal packages/* boundaries',
        action:
          'remove the corresponding import, frozen policy record, and architecture tests in the same change',
        indefiniteRetentionAllowed: false,
      });

      const adr = await readFile(
        resolve(
          repositoryRoot,
          'docs/adr/0002-extension-and-web-share-a-monorepo.md',
        ),
        'utf8',
      );
      expect(adr).toContain('reachable closure');
      expect(adr).toContain('同时删除架构策略中的冻结记录');
      expect(adr).toContain('不能作为无限期保留');
    });
  });

  it('passes against the checked-in repository', async () => {
    await expect(scanExtensionArchitecture(repositoryRoot)).resolves.toEqual([]);
  }, 15_000);
});
