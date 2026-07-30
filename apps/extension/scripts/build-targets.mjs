import { resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dirname, '..');
const absoluteOutDirs = Object.freeze({
  chrome: resolve(extensionRoot, 'dist/chrome'),
  firefox: resolve(extensionRoot, 'dist/firefox'),
  benchmark: resolve(extensionRoot, 'dist/benchmark'),
});

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
});

export function resolveExtensionBuildTarget(target) {
  const descriptor = extensionBuildTargets[target];
  if (!descriptor) {
    throw new Error(`Unsupported extension build target: ${target}`);
  }
  return {
    ...descriptor,
    target,
    absoluteOutDir: absoluteOutDirs[target],
  };
}
