import { startBackground } from '../../../src/background/index';
import {
  createChromeExtensionAdapter,
} from './capabilities/chromeAdapter';
import {
  createChromePipelineHostLifecycle,
} from './pipelineHost/chromeLifecycle';

const nativeChrome = (globalThis as typeof globalThis & {
  chrome?: unknown;
}).chrome;

if (!nativeChrome) {
  throw new Error('Extension background capabilities are unavailable');
}

startBackground(
  createChromeExtensionAdapter(nativeChrome).background(),
  createChromePipelineHostLifecycle(nativeChrome),
);
