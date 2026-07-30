import {
  createChromeExtensionAdapter,
} from './capabilities/chromeAdapter';
import { mountPopup } from '../../../src/popup/main';

const nativeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
if (!nativeChrome) {
  throw new Error('Chrome extension capabilities are unavailable');
}
const capabilities = createChromeExtensionAdapter(nativeChrome).popup();

mountPopup({
  runtimeRequests: capabilities.runtimeRequests,
  extensionVersion: capabilities.environment.metadata.version,
});
