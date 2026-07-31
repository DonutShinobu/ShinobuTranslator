import type {
  ExtensionCapabilityAdapter,
} from './contracts';
import type {
  PipelineHostDocumentLifecycle,
} from '../pipelineHost/contracts';
import {
  createChromeExtensionAdapter,
} from './chromeAdapter';
import {
  createChromePipelineHostLifecycle,
} from '../pipelineHost/chromeLifecycle';

function nativeChromeApi(): unknown {
  return (globalThis as typeof globalThis & {
    chrome?: unknown;
  }).chrome;
}

export function createTargetExtensionAdapter(): ExtensionCapabilityAdapter {
  return createChromeExtensionAdapter(nativeChromeApi());
}

export function createTargetPipelineHostLifecycle():
PipelineHostDocumentLifecycle {
  return createChromePipelineHostLifecycle(nativeChromeApi());
}
