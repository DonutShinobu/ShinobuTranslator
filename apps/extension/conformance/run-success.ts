import {
  compareConformanceObservations,
  normalizeConformanceObservation,
} from './harness';
import {
  runChromeConformanceDriver,
} from './drivers/chrome';
import {
  runFirefoxConformanceDriver,
} from './drivers/firefox';

const chrome = await runChromeConformanceDriver();
const firefox = await runFirefoxConformanceDriver();
const normalizedChrome = normalizeConformanceObservation(chrome.observation);
const normalizedFirefox = normalizeConformanceObservation(firefox.observation);
const comparison = compareConformanceObservations(
  normalizedChrome,
  normalizedFirefox,
);

console.log(JSON.stringify({
  comparison,
  scenarioId: normalizedChrome.scenarioId,
  chrome: {
    browserVersion: chrome.browserVersion,
    packagePath: chrome.packagePath,
    host: chrome.observation.host,
  },
  firefox: {
    browserVersion: firefox.browserVersion,
    packagePath: firefox.packagePath,
    host: firefox.observation.host,
  },
  excludedFields: normalizedChrome.excludedFields,
}, null, 2));
