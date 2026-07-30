import { startOffscreenPipelineHost } from '../../../src/offscreen/index';
import { createChromeExtensionAdapter } from './capabilities/chromeAdapter';
import {
  createChromePipelineHostLifecycle,
} from './pipelineHost/chromeLifecycle';

const nativeChrome = (globalThis as typeof globalThis & {
  chrome?: unknown;
}).chrome;

if (!nativeChrome) {
  throw new Error('扩展 pipeline host capability 不可用');
}

startOffscreenPipelineHost(
  createChromeExtensionAdapter(nativeChrome).pipelineHost(),
  createChromePipelineHostLifecycle(nativeChrome),
);
