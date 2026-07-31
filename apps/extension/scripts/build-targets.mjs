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
