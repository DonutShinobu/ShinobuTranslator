import { resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(extensionRoot, '../..');

export const extensionBuildTargets = Object.freeze({
  chrome: Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/chrome',
    release: true,
  }),
  firefox: Object.freeze({
    browser: 'firefox',
    manifestTarget: 'firefox',
    outDir: 'apps/extension/dist/firefox',
    release: true,
  }),
  benchmark: Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/benchmark',
    release: false,
  }),
  'conformance-chrome': Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/conformance/chrome',
    release: false,
    conformance: true,
  }),
  'conformance-firefox': Object.freeze({
    browser: 'firefox',
    manifestTarget: 'firefox',
    outDir: 'apps/extension/dist/conformance/firefox',
    release: false,
    conformance: true,
  }),
  'conformance-detector-chrome': Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/conformance/detector/chrome',
    release: false,
    conformance: true,
    conformanceProfile: 'detector-failure',
  }),
  'conformance-detector-firefox': Object.freeze({
    browser: 'firefox',
    manifestTarget: 'firefox',
    outDir: 'apps/extension/dist/conformance/detector/firefox',
    release: false,
    conformance: true,
    conformanceProfile: 'detector-failure',
  }),
  'conformance-translation-chrome': Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/conformance/translation/chrome',
    release: false,
    conformance: true,
    conformanceProfile: 'translation-failure',
  }),
  'conformance-translation-firefox': Object.freeze({
    browser: 'firefox',
    manifestTarget: 'firefox',
    outDir: 'apps/extension/dist/conformance/translation/firefox',
    release: false,
    conformance: true,
    conformanceProfile: 'translation-failure',
  }),
  'conformance-lifecycle-chrome': Object.freeze({
    browser: 'chrome',
    manifestTarget: 'chrome',
    outDir: 'apps/extension/dist/conformance/lifecycle/chrome',
    release: false,
    conformance: true,
    conformanceProfile: 'lifecycle',
  }),
  'conformance-lifecycle-firefox': Object.freeze({
    browser: 'firefox',
    manifestTarget: 'firefox',
    outDir: 'apps/extension/dist/conformance/lifecycle/firefox',
    release: false,
    conformance: true,
    conformanceProfile: 'lifecycle',
  }),
});

export function resolveExtensionBuildTarget(target) {
  const descriptor = extensionBuildTargets[target];
  if (!descriptor) {
    throw new Error(`Unsupported extension build target: ${target}`);
  }
  return {
    ...descriptor,
    target,
    absoluteOutDir: resolve(repositoryRoot, descriptor.outDir),
  };
}
