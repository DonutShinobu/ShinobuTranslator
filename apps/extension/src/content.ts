import { startContent } from '../../../src/content/index';
import {
  createChromeContentCapabilities,
} from './capabilities/chromeAdapter';

const nativeChrome = (globalThis as typeof globalThis & {
  chrome?: unknown;
}).chrome;

if (!nativeChrome) {
  throw new Error('Extension content capabilities are unavailable');
}

startContent(createChromeContentCapabilities(nativeChrome));
