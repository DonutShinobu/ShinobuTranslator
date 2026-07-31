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
const normalizedChrome = chrome.observations.map(normalizeConformanceObservation);
const normalizedFirefox = firefox.observations.map(normalizeConformanceObservation);
const firefoxByScenario = new Map(
  normalizedFirefox.map((observation) => [observation.scenarioId, observation]),
);
const comparisons = normalizedChrome.map((chromeObservation) => {
  const firefoxObservation = firefoxByScenario.get(chromeObservation.scenarioId);
  if (!firefoxObservation) {
    throw new Error(`Firefox omitted ${chromeObservation.scenarioId}`);
  }
  return {
    scenarioId: chromeObservation.scenarioId,
    strictComparison: compareConformanceObservations(
      chromeObservation,
      firefoxObservation,
    ),
  };
});

console.log(JSON.stringify({
  matrixVersion: 1,
  comparisons,
  chrome: {
    browserVersion: chrome.browserVersion,
    packagePath: chrome.packagePath,
    host: chrome.observations[0]?.host,
  },
  firefox: {
    browserVersion: firefox.browserVersion,
    packagePath: firefox.packagePath,
    host: firefox.observations[0]?.host,
  },
  excludedFields: normalizedChrome[0]?.excludedFields,
}, null, 2));
