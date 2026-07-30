import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
      'src/background/globalObjectContainer.ts',
      [
        'const box = { root: globalThis };',
        'box.root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/nestedGlobalAlias.ts',
      [
        'const root = globalThis.window;',
        'root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/nestedGlobalContainer.ts',
      [
        'const box = { root: globalThis.window };',
        'box.root.chrome.runtime.sendMessage({});',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/nestedGlobalEval.ts',
      'globalThis.window.eval(sourceText);',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/nestedGlobalFunction.ts',
      'window.self.Function(sourceText)();',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/globalObjectShorthandContainer.ts',
      [
        'const root = globalThis;',
        'const box = { root };',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/globalObjectArray.ts',
      'const roots = [window];',
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/globalObjectReturn.ts',
      [
        'const root = self;',
        'function leak() { return root; }',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/globalObjectArgument.ts',
      'consume(globalThis);',
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/globalObjectPropertyAssignment.ts',
      [
        'const box = {};',
        'const root = window;',
        'box.root = root;',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/globalObjectBinaryEscape.ts',
      'const box = { root: fallback || globalThis };',
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/exportedGlobalAlias.ts',
      [
        'const root = self;',
        'export { root };',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/computedNativeNamespace.ts',
      'globalThis["ch" + "rome"].runtime.sendMessage({});',
      'native extension namespace access',
    ],
    [
      'src/background/computedNativeNamespaceAlias.ts',
      [
        'const prefix = "ch";',
        'const namespace = prefix + "rome";',
        'globalThis[namespace].runtime.sendMessage({});',
      ].join('\n'),
      'native extension namespace access',
    ],
    [
      'src/background/computedReflectNamespace.ts',
      'Reflect.get(globalThis, "ch" + "rome").runtime.sendMessage({});',
      'native extension namespace access',
    ],
    [
      'src/background/dynamicGlobalMember.ts',
      [
        'declare const key: string;',
        'globalThis[key].runtime.sendMessage({});',
      ].join('\n'),
      'dynamic browser-global member access is forbidden',
    ],
    [
      'src/background/dynamicGlobalDestructure.ts',
      [
        'declare const key: string;',
        'const { [key]: api } = globalThis;',
        'api.runtime.sendMessage({});',
      ].join('\n'),
      'dynamic browser-global member access is forbidden',
    ],
    [
      'src/background/directEval.ts',
      'eval("globalThis.chrome.runtime.sendMessage({})");',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/aliasedEval.ts',
      [
        'const run = eval;',
        'run(sourceText);',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/functionConstructor.ts',
      'const run = new Function("return globalThis.chrome");',
      'dynamic code generation is forbidden',
    ],
    [
      'apps/extension/build/codegenAdapter.ts',
      [
        'const Factory = globalThis["Fun" + "ction"];',
        'Factory(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/destructuredEval.ts',
      [
        'const { ["ev" + "al"]: run } = globalThis;',
        'run(sourceText);',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/indirectFunctionConstructor.ts',
      [
        'const HiddenFunction = (() => {}).constructor;',
        'HiddenFunction("return globalThis.chrome")();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/destructuredFunctionConstructor.ts',
      [
        'const { constructor: HiddenFunction } = () => {};',
        'HiddenFunction("return globalThis.chrome")();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/reflectFunctionConstructor.ts',
      'Reflect.get(() => {}, "constructor")("return globalThis.chrome")();',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/computedReflectFunctionConstructor.ts',
      [
        'const property = "con" + "structor";',
        'Reflect.get(() => {}, property)("return globalThis.chrome")();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/objectWrappedFunctionConstructor.ts',
      [
        'const box = { F: (() => {}).constructor };',
        'box.F(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/arrayWrappedFunctionConstructor.ts',
      [
        'const box = [(() => {}).constructor];',
        'box[0](sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/returnedFunctionConstructor.ts',
      [
        'function factory() {',
        '  return (() => {}).constructor;',
        '}',
        'factory()(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/opaqueFunctionConstructor.ts',
      'identity((() => {}).constructor)(sourceText)();',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/conditionalFunctionConstructor.ts',
      [
        'const F = condition ? (() => {}).constructor : safe;',
        'F(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/composedFunctionConstructor.ts',
      [
        'const F = (() => {}).constructor;',
        '(0, F)(sourceText)();',
        '(F || fallback)(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/objectWrappedReflectConstructor.ts',
      [
        'const box = { F: Reflect.get(() => {}, "constructor") };',
        'box.F(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/reflectApplyFunctionConstructor.ts',
      [
        'const F = (() => {}).constructor;',
        'Reflect.apply(',
        '  F,',
        '  null,',
        '  ["return globalThis.chrome"],',
        ')();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/reflectConstructFunctionConstructor.ts',
      [
        'const F = (() => {}).constructor;',
        'Reflect.construct(',
        '  F,',
        '  ["return globalThis.chrome"],',
        ')();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/computedReflectGetConstructor.ts',
      'Reflect["get"](() => {}, "constructor")(sourceText)();',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/dynamicReflectGetConstructor.ts',
      'Reflect.get(() => {}, key)(sourceText)();',
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/aliasedReflectGetConstructor.ts',
      [
        'const get = Reflect.get;',
        'get(() => {}, "constructor")(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/destructuredReflectGetConstructor.ts',
      [
        'const { get } = Reflect;',
        'get(() => {}, "constructor")(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/aliasedReflectNamespaceConstructor.ts',
      [
        'const reflection = Reflect;',
        'reflection.get(',
        '  () => {},',
        '  "constructor",',
        ')(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/calledReflectGetConstructor.ts',
      [
        'Reflect.get.call(',
        '  Reflect,',
        '  () => {},',
        '  "constructor",',
        ')(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/appliedReflectGetConstructor.ts',
      [
        'Reflect.get.apply(',
        '  Reflect,',
        '  [() => {}, "constructor"],',
        ')(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/boundReflectGetConstructor.ts',
      [
        'const get = Reflect.get.bind(Reflect);',
        'get(() => {}, "constructor")(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/reassignedSafeConstructor.ts',
      [
        'let parser = { constructor: (value) => value };',
        'parser = () => {};',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/unknownOwnConstructor.ts',
      [
        'declare const unknown: any;',
        'const parser = { constructor: unknown };',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/callResultOwnConstructor.ts',
      [
        'const parser = { constructor: getFactory() };',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/dynamicReflectOwnConstructor.ts',
      [
        'const parser = {',
        '  constructor: Reflect.get(() => {}, key),',
        '};',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/mutatedOwnConstructor.ts',
      [
        'const parser = { constructor: (value) => value };',
        'mutate(parser);',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/aliasedMutatedOwnConstructor.ts',
      [
        'const parser = { constructor: (value) => value };',
        'const alias = parser;',
        'mutate(alias);',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/containedMutatedOwnConstructor.ts',
      [
        'const parser = { constructor: (value) => value };',
        'const box = { parser };',
        'mutate(box.parser);',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/returnedMutatedOwnConstructor.ts',
      [
        'const parser = { constructor: (value) => value };',
        'function leak() { return parser; }',
        'mutate(leak());',
        'parser.constructor(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/background/exportedFunctionConstructor.ts',
      'export const F = (() => {}).constructor;',
      'dynamic code generation is forbidden',
    ],
    [
      'apps/extension/build/codegenAdapter.ts',
      [
        'const key = getKey();',
        'Reflect.get(globalThis, key)(sourceText)();',
      ].join('\n'),
      'global object cannot be passed to opaque calls',
    ],
    [
      'apps/extension/build/objectGlobalAdapter.ts',
      [
        'const box = { root: globalThis };',
        'Reflect.get(box.root, key)(sourceText)();',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'apps/extension/build/arrayGlobalAdapter.ts',
      [
        'const roots = [globalThis];',
        'Object.getOwnPropertyDescriptor(',
        '  roots[0],',
        '  "Function",',
        ')?.value(sourceText)();',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'apps/extension/build/returnedGlobalAdapter.ts',
      [
        'function root() { return globalThis; }',
        'Reflect.get(root(), key)(sourceText)();',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'apps/extension/build/conditionalGlobalAdapter.ts',
      [
        'const root = condition ? globalThis : fallback;',
        'Reflect.get(root, key)(sourceText)();',
      ].join('\n'),
      'global object value cannot escape adapter boundary',
    ],
    [
      'src/background/exportedGlobalRoot.ts',
      'export const root = globalThis;',
      'global object value cannot escape adapter boundary',
    ],
    [
      'apps/extension/src/capabilities/exportedNative.ts',
      'export const api = globalThis.chrome;',
      'raw native extension namespace cannot be exported',
    ],
    [
      'apps/extension/src/capabilities/reexportedNative.ts',
      [
        'const api = globalThis.chrome;',
        'export { api };',
      ].join('\n'),
      'raw native extension namespace cannot be exported',
    ],
    [
      'src/background/exportedDestructuredConstructor.ts',
      'export const { constructor: F } = () => {};',
      'sensitive architecture capability cannot be exported',
    ],
    [
      'src/background/exportedReflectGet.ts',
      'export const get = Reflect.get;',
      'sensitive architecture capability cannot be exported',
    ],
    [
      'src/background/exportedDestructuredReflectGet.ts',
      'export const { get } = Reflect;',
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/config/exportedRequire.cts',
      'export const load = require;',
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/src/capabilities/defaultNative.ts',
      [
        'const api = globalThis.chrome;',
        'export default api;',
      ].join('\n'),
      'raw native extension namespace cannot be exported',
    ],
    [
      'apps/extension/src/capabilities/containedNative.ts',
      [
        'const api = globalThis.chrome;',
        'export const leak = { api };',
      ].join('\n'),
      'raw native extension namespace cannot be exported',
    ],
    [
      'apps/extension/src/capabilities/returnedNative.ts',
      [
        'const api = globalThis.chrome;',
        'export const leak = () => api;',
      ].join('\n'),
      'raw native extension namespace cannot be exported',
    ],
    [
      'apps/extension/src/capabilities/commonJsNative.cts',
      [
        'const api = globalThis.chrome;',
        'module.exports = api;',
      ].join('\n'),
      'raw native extension namespace cannot be exported',
    ],
    [
      'apps/extension/build/codegenAdapter.ts',
      [
        'Object.getOwnPropertyDescriptor(',
        '  globalThis,',
        '  "Function",',
        ')?.value(sourceText)();',
      ].join('\n'),
      'global object cannot be passed to opaque calls',
    ],
    [
      'apps/extension/config/requireCall.cts',
      'require.call(null, getLegacyTarget());',
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/sequenceRequire.cts',
      '(0, require)(getLegacyTarget());',
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/conditionalRequire.cts',
      '(condition ? require : fallback)(getLegacyTarget());',
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/reflectRequire.cts',
      [
        'Reflect.apply(',
        '  require,',
        '  null,',
        '  [getLegacyTarget()],',
        ');',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/moduleRequireCall.cts',
      'module.require.call(module, getLegacyTarget());',
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/aliasedModuleRequire.cts',
      [
        'const mod = module;',
        'mod.require(getLegacyTarget());',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/namespacedCreateRequire.mts',
      [
        'import * as nodeModule from "node:module";',
        'nodeModule.createRequire(import.meta.url)(',
        '  getLegacyTarget(),',
        ');',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/defaultCreateRequire.mts',
      [
        'import nodeModule from "node:module";',
        'nodeModule.createRequire(import.meta.url)(',
        '  getLegacyTarget(),',
        ');',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/destructuredCreateRequire.mts',
      [
        'import * as nodeModule from "node:module";',
        'const { createRequire } = nodeModule;',
        'const load = createRequire(import.meta.url);',
        'load(getLegacyTarget());',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/destructuredModuleRequire.cts',
      [
        'const { require: load } = module;',
        'load(getLegacyTarget());',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/mutableDestructuredCreateRequire.mts',
      [
        'import * as nodeModule from "node:module";',
        'let { createRequire } = nodeModule;',
        'const load = createRequire(import.meta.url);',
        'load(process.env.TARGET);',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/varDestructuredModuleRequire.cts',
      [
        'var { require: load } = module;',
        'load(process.env.TARGET);',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/restNodeModule.mts',
      [
        'import * as nodeModule from "node:module";',
        'const { ...copy } = nodeModule;',
        'copy.createRequire(import.meta.url)(getTarget());',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'apps/extension/config/restCommonJsModule.cts',
      [
        'const { ...copy } = module;',
        'copy.require(getTarget());',
      ].join('\n'),
      'dynamic extension build loading can hide',
    ],
    [
      'src/shared/functionPrototypeDescriptor.ts',
      [
        'Object.getOwnPropertyDescriptor(',
        '  Object.getPrototypeOf(() => {}),',
        '  "constructor",',
        ').value(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/shared/functionPrototypeDescriptors.ts',
      [
        'Object.getOwnPropertyDescriptors(',
        '  Object.getPrototypeOf(() => {}),',
        ').constructor.value(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/shared/aliasedFunctionPrototypeDescriptor.ts',
      [
        'const descriptor = Object.getOwnPropertyDescriptor(',
        '  Object.getPrototypeOf(() => {}),',
        '  "constructor",',
        ');',
        'descriptor.value(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'src/shared/destructuredFunctionPrototypeDescriptor.ts',
      [
        'const { value } = Object.getOwnPropertyDescriptor(',
        '  Object.getPrototypeOf(() => {}),',
        '  "constructor",',
        ');',
        'value(sourceText)();',
      ].join('\n'),
      'dynamic code generation is forbidden',
    ],
    [
      'packages/browser-runtime/src/index.ts',
      'type Port = ChromePort;',
      'native extension API type',
    ],
    [
      'packages/browser-runtime/src/firefox.ts',
      'type Port = FirefoxPort;',
      'native extension API type',
    ],
    [
      'src/shared/firefoxRuntime.ts',
      'interface FirefoxRuntime {}',
      'native extension API type',
    ],
    [
      'src/shared/firefoxTarget.ts',
      'const isFirefoxTarget = detectTarget();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/chromeTarget.ts',
      'const isChromeTarget = detectTarget();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/lowercaseChromeTarget.ts',
      'const chromeTarget = detectTarget();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/lowercaseFirefoxRuntime.ts',
      'const firefoxRuntime = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/snakeFirefox.ts',
      'const is_firefox = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/firefoxProperty.ts',
      'if (targets.firefox) return;',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/useChromeRuntime.ts',
      'const useChromeRuntime = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/browserIsFirefox.ts',
      'const browserIsFirefox = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/lowercaseChromeProbe.ts',
      'const ischrome = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/lowercaseFirefoxProbe.ts',
      'const isfirefoxruntime = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/shared/mixedCaseChromeProbe.ts',
      'const isChromeextension = detectRuntime();',
      'browser-specific branch or brand',
    ],
    [
      'src/pipeline/resources.ts',
      'const url = "chrome-extension://models/detector.onnx";',
      'platform extension URL scheme',
    ],
    [
      'src/pipeline/computedResources.ts',
      'const url = "chrome" + "-extension://models/detector.onnx";',
      'platform extension URL scheme',
    ],
    [
      'src/pipeline/templateResources.ts',
      'const url = `${"moz"}-extension://models/detector.onnx`;',
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
      'src/background/computedError.ts',
      [
        'if (message.includes(',
        '  "Receiving end " + "does not exist",',
        ')) return;',
      ].join('\n'),
      'browser error text control flow',
    ],
    [
      'src/background/assignedComputedError.ts',
      [
        'let message;',
        'message = "Receiving end " + "does not exist";',
        'if (error.includes(message)) return;',
      ].join('\n'),
      'browser error text control flow',
    ],
    [
      'src/shared/assignedBrowserBrand.ts',
      [
        'let target;',
        'target = "fire" + "fox";',
        'if (target === runtimeName) return;',
      ].join('\n'),
      'browser-specific branch or brand',
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
      'extension build source cannot reference root src/**',
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
      'extension build source cannot reference root src/**',
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
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'function legacy() {',
        '  return resolve(repoRoot, "src/shared/x.ts");',
        '}',
        'const input = { x: legacy() };',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const legacyUrl = new URL(',
        '  "../../src/shared/x.ts",',
        '  import.meta.url,',
        ');',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'declare const repoRoot: string;',
        'function legacy(name: string) {',
        '  return `${repoRoot}/src/shared/${name}.ts`;',
        '}',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = path.resolve(extensionRoot, "../..");',
        'const legacy =',
        '  `${repoRoot}${path.sep}src${path.sep}shared${path.sep}x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve, sep } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const legacy = `${repoRoot}${sep}src${sep}shared/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve, sep as slash } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'const legacy = `${repoRoot}${slash}src${slash}shared/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'declare const slash: string;',
        'const legacy = `${repoRoot}${slash}src${slash}shared/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'declare const segment: string;',
        'const legacy = `${repoRoot}/${segment}/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        'declare const segment: string;',
        'const legacy = resolve(repoRoot, segment, "x.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'declare const relative: string;',
        'const legacy = new URL(relative, import.meta.url);',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'declare const segment: string;',
        'const legacy = resolve(extensionRoot, segment, "x.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { join } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'declare const segment: string;',
        'const legacy = join(extensionRoot, segment, "x.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const extensionRoot = import.meta.dirname;',
        'declare const segment: string;',
        'const legacy = `${extensionRoot}/${segment}/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'let base = import.meta.dirname;',
        'base = resolve(base, "../..");',
        'const legacy = resolve(base, "src/background/index.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'let base = import.meta.url;',
        'base = new URL("../../", base);',
        'const legacy = new URL("src/background/index.ts", base);',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/build/exportedRootPath.mts',
      [
        'import { resolve } from "node:path";',
        'export const repoRoot = resolve(',
        '  import.meta.dirname,',
        '  "../../..",',
        ');',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'function root() {',
        '  return resolve(extensionRoot, "../..");',
        '}',
        'resolve(root(), getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const root = () => resolve(extensionRoot, "../..");',
        'resolve(root(), getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const paths = {',
        '  root: resolve(extensionRoot, "../.."),',
        '};',
        'resolve(paths.root, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const paths = [resolve(extensionRoot, "../..")];',
        'resolve(paths[0], getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'export function root() {',
        '  return resolve(extensionRoot, "../..");',
        '}',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'function base() {',
        '  return import.meta.url;',
        '}',
        'new URL(getRelative(), base());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const paths = { base: import.meta.url };',
        'new URL(getRelative(), paths.base);',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repo = resolve(extensionRoot, "../..");',
        'export default { repo };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repo = resolve(extensionRoot, "../..");',
        'export const anchors = [repo];',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repo = resolve(extensionRoot, "../..");',
        'export function getRepo() {',
        '  const anchor = repo;',
        '  return anchor;',
        '}',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const repo = new URL("../..", import.meta.url);',
        'export const anchors = { repo };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export default {',
        '  getRepo() { return repo; },',
        '};',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export default { getRepo: () => repo };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export default [() => repo];',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'function getRepo() { return repo; }',
        'export { getRepo };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const repo = new URL("../..", import.meta.url);',
        'const getRepo = () => repo;',
        'export default getRepo;',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export default () => repo;',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export class Paths {',
        '  static root() { return repo; }',
        '}',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'class Paths { root = () => repo; }',
        'export { Paths };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export class Paths {',
        '  root = repo;',
        '  get base() { return repo; }',
        '}',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export class Paths {',
        '  constructor() { this.root = repo; }',
        '}',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export function* roots() { yield repo; }',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export default { *roots() { yield repo; } };',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'export async function* roots() { yield await repo; }',
      ].join('\n'),
      'sensitive architecture capability cannot be exported',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'const input = repo + "/" + getSegment();',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const repo = resolve(import.meta.dirname, "../..");',
        'const input = repo.concat("/", getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const { pathname } = new URL("../..", import.meta.url);',
        'resolve(pathname, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const base = condition',
        '  ? new URL("../..", import.meta.url)',
        '  : new URL("../..", import.meta.url);',
        'resolve(base.pathname, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'const repo = new URL("../..", import.meta.url).pathname;',
        'const input = repo + "/" + getSegment();',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const repo = fileURLToPath(',
        '  new URL("../..", import.meta.url),',
        ');',
        'resolve(repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const roots = {',
        '  repo: resolve(import.meta.dirname, "../.."),',
        '};',
        'const { repo } = roots;',
        'resolve(repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const roots = [',
        '  resolve(import.meta.dirname, "../.."),',
        '];',
        'const [repo] = roots;',
        'resolve(repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const roots = {',
        '  repo: resolve(import.meta.dirname, "../.."),',
        '};',
        'const copy = { ...roots };',
        'resolve(copy.repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'let repo;',
        'repo = resolve(import.meta.dirname, "../..");',
        'resolve(repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const roots = {};',
        'roots.repo = resolve(import.meta.dirname, "../..");',
        'resolve(roots.repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'function build(',
        '  repo = resolve(import.meta.dirname, "../.."),',
        ') {',
        '  resolve(repo, getSegment());',
        '}',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const roots = Object.freeze({',
        '  repo: resolve(import.meta.dirname, "../.."),',
        '});',
        'resolve(roots.repo, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'function root() {',
        '  return new URL("../..", import.meta.url);',
        '}',
        'const paths = { root: root() };',
        'resolve(paths.root.pathname, getSegment());',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = path.resolve(extensionRoot, "../..");',
        'const slash = "/";',
        'const legacy =',
        '  `${repoRoot}${slash}src${slash}shared/x.ts`;',
      ].join('\n'),
      'extension build source cannot reference root src/**',
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
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import path from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = path.posix.resolve(extensionRoot, "../..");',
        'const input = path.posix.resolve(repoRoot, "src/shared/x.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/build/arbitraryEntryAdapter.ts',
      [
        'import { join } from "node:path";',
        'const extensionRoot = join(import.meta.dirname, "..");',
        'const repoRoot = join(extensionRoot, "../..");',
        'export const entry = join(repoRoot, "src/workers/arbitrary.ts");',
      ].join('\n'),
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      'const input = "../../src/shared/diagnosticLogClient.ts";',
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      'const input = "src/shared/diagnosticLogClient.ts";',
      'extension build source cannot reference root src/**',
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
      'extension build source cannot reference root src/**',
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
      'extension build source cannot reference root src/**',
    ],
    [
      'apps/extension/vite.config.ts',
      [
        'import { resolve } from "node:path";',
        'const extensionRoot = import.meta.dirname;',
        'const repoRoot = resolve(extensionRoot, "../..");',
        String.raw`const input = resolve(repoRoot, "src\\shared\\diagnosticLogClient.ts");`,
      ].join('\n'),
      'extension build source cannot reference root src/**',
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
      ]), `${relativePath}\n${source}`).toEqual(expect.arrayContaining([
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
          '  diagnostics: resolve(repoRoot, "assets/label.ts"),',
          '};',
        ].join('\n'),
      },
    ])).toEqual([]);
  });

  it('allows local names and ordinary values unrelated to hidden edges', () => {
    expect(findSourcePolicyViolations([
      {
        relativePath: 'src/shared/localEvaluator.ts',
        source: [
          'export function evaluate(eval, Function) {',
          '  const parser = { eval: (value) => value };',
          '  return parser.eval(eval(Function));',
          '}',
          'export const metadata = { root: "application" };',
          'export const chromebook = "device family";',
          'export const chromium = "engine family";',
          'export const monochromeMode = "grayscale";',
          'export const MonochromePalette = "grayscale";',
          'export const polychrome = "multi-channel";',
          'export const browserTarget = "host-neutral target";',
          'export function nameOf(value) {',
          '  return value.constructor.name;',
          '}',
          'export function captureConstructor(value) {',
          '  const { constructor } = value;',
          '  return constructor.name;',
          '}',
          'export const parser = { constructor: (value) => value };',
          'parser.constructor("safe");',
          'Reflect.get(parser, "constructor")("safe");',
          'export function useLocalReflect(Reflect) {',
          '  const localParser = { constructor: (value) => value };',
          '  return Reflect.get(localParser, "constructor")("safe");',
          '}',
          'const selectedParser = condition',
          '  ? { constructor: (value) => value }',
          '  : { constructor: (value) => value };',
          'selectedParser.constructor("safe");',
          'const frozenParser = Object.freeze({',
          '  constructor: (value) => value,',
          '});',
          'frozenParser.constructor("safe");',
          'let mutableGet = Reflect.get;',
          'mutableGet = localGet;',
          'mutableGet(value, "constructor")("safe");',
          'let mutableReflect = Reflect;',
          'mutableReflect = localReflect;',
          'mutableReflect.get(value, "constructor")("safe");',
          'export const isObjectConstructor =',
          '  Object.prototype.constructor === Object;',
        ].join('\n'),
      },
      {
        relativePath: 'apps/extension/vite.config.ts',
        source: [
          'import path from "node:path";',
          'const extensionRoot = import.meta.dirname;',
          'const docs = new URL(',
          '  "https://example.com/src/reference.html",',
          ');',
          'const appEntry = new URL(',
          '  "./src/background.ts",',
          '  import.meta.url,',
          ');',
          'const appBase = import.meta.url;',
          'const aliasedAppEntry = new URL(',
          '  "./src/background.ts",',
          '  appBase,',
          ');',
          'const appDirectory = new URL(".", import.meta.url);',
          'const nestedAppEntry = new URL(',
          '  "./src/background.ts",',
          '  appDirectory,',
          ');',
          'const appTemplate =',
          '  `${extensionRoot}${path.sep}src/background.ts`;',
          'const metadata = { label: "source map" };',
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
        'TypeScript import-equals',
        'import legacy = require("../../../../src/shared/config");',
      ],
      [
        'CommonJS module.require',
        'module.require("../../../../src/shared/config");',
      ],
      [
        'aliased CommonJS require',
        [
          'const load = require;',
          'load("../../../../src/shared/config");',
        ].join('\n'),
      ],
      [
        'createRequire loader',
        [
          'import { createRequire } from "node:module";',
          'const load = createRequire(import.meta.url);',
          'load("../../../../src/shared/config");',
        ].join('\n'),
      ],
      [
        'require.resolve',
        'require.resolve("../../../../src/shared/config");',
      ],
    ])('rejects a third edge loaded through %s', (_name, source) => {
      expect(findFrozenMigrationEdgeViolations([
        ...frozenMigrationFiles,
        {
          relativePath:
            'apps/extension/src/capabilities/hidden.cts',
          source,
        },
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'only the two frozen background/content app-to-root migration edges',
        ),
      ]));
    });

    it('counts TypeScript import types as real frozen references', () => {
      expect(findFrozenMigrationEdgeViolations([
        {
          ...frozenMigrationFiles[0],
          source: [
            frozenMigrationFiles[0].source,
            'export type Hidden = typeof import(',
            '  "../../../src/background/index"',
            ');',
          ].join('\n'),
        },
        frozenMigrationFiles[1],
      ])).toEqual(expect.arrayContaining([
        expect.stringContaining('must exist exactly once'),
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

  it('scans extension source in previously unknown app directories', async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), 'shinobu-architecture-'),
    );
    try {
      const hiddenDirectory = resolve(
        temporaryRoot,
        'apps/extension/config',
      );
      await mkdir(hiddenDirectory, { recursive: true });
      await writeFile(
        resolve(hiddenDirectory, 'hidden.mts'),
        'void import(getLegacyTarget());',
        'utf8',
      );
      await expect(
        scanExtensionArchitecture(temporaryRoot),
      ).resolves.toEqual(expect.arrayContaining([
        expect.stringContaining(
          'apps/extension/config/hidden.mts: dynamic extension build loading can hide',
        ),
      ]));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
