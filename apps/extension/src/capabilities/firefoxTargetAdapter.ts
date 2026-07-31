import type {
  ExtensionCapabilityAdapter,
} from './contracts';
import type {
  PipelineHostDocumentLifecycle,
} from '../pipelineHost/contracts';
import {
  createChromeCompatibilityCapabilities,
} from './chromeCompatibility';
import {
  createFirefoxExtensionAdapter,
} from './firefoxAdapter';
import {
  createFirefoxPipelineHostLifecycle,
} from '../pipelineHost/firefoxLifecycle';

function nativeFirefoxApi(): unknown {
  return (globalThis as typeof globalThis & {
    browser?: unknown;
  }).browser;
}

function nativeFirefoxCompatibilityApi(): unknown {
  return (globalThis as typeof globalThis & {
    chrome?: unknown;
  }).chrome;
}

export function createTargetExtensionAdapter(): ExtensionCapabilityAdapter {
  return createFirefoxExtensionAdapter(
    nativeFirefoxApi(),
    createChromeCompatibilityCapabilities(nativeFirefoxCompatibilityApi()),
  );
}

export function createTargetPipelineHostLifecycle():
PipelineHostDocumentLifecycle {
  return createFirefoxPipelineHostLifecycle();
}
