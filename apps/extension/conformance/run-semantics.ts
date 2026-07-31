import {
  compareSemanticTraceObservations,
  normalizeSemanticTraceObservation,
} from './semanticHarness';
import {
  runChromeSemanticConformanceDriver,
  type SemanticConformanceProfile,
} from './drivers/chromeSemantic';
import {
  runFirefoxSemanticConformanceDriver,
} from './drivers/firefoxSemantic';

const allProfiles: SemanticConformanceProfile[] = [
  'detector',
  'translation',
  'lifecycle',
];
const requestedProfile = process.argv[2] as
  | SemanticConformanceProfile
  | undefined;
if (requestedProfile && !allProfiles.includes(requestedProfile)) {
  throw new Error(`Unknown semantic conformance profile: ${requestedProfile}`);
}
const profiles = requestedProfile ? [requestedProfile] : allProfiles;
const requestedBrowser = process.argv[3];
if (
  requestedBrowser !== undefined
  && requestedBrowser !== 'chrome'
  && requestedBrowser !== 'firefox'
) {
  throw new Error(`Unknown semantic conformance browser: ${requestedBrowser}`);
}
if (requestedProfile && requestedBrowser) {
  const result = requestedBrowser === 'chrome'
    ? await runChromeSemanticConformanceDriver(requestedProfile)
    : await runFirefoxSemanticConformanceDriver(requestedProfile);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
const comparisons: Array<{
  scenarioId: string;
  matches: true;
}> = [];
const environments: Array<{
  profile: SemanticConformanceProfile;
  chromeVersion: string;
  firefoxVersion: string;
}> = [];

for (const profile of profiles) {
  const chrome = await runChromeSemanticConformanceDriver(profile);
  const firefox = await runFirefoxSemanticConformanceDriver(profile);
  if (chrome.observations.length !== firefox.observations.length) {
    throw new Error(`Semantic scenario count differs for ${profile}`);
  }
  for (const [index, chromeObservation] of chrome.observations.entries()) {
    const firefoxObservation = firefox.observations[index];
    if (!firefoxObservation) {
      throw new Error(`Firefox semantic scenario ${index} is missing`);
    }
    let normalizedChrome;
    let normalizedFirefox;
    try {
      normalizedChrome = normalizeSemanticTraceObservation(chromeObservation);
      normalizedFirefox = normalizeSemanticTraceObservation(
        firefoxObservation,
      );
    } catch (error) {
      console.error(JSON.stringify({
        profile,
        chrome: chromeObservation,
        firefox: firefoxObservation,
      }, null, 2));
      throw error;
    }
    comparisons.push({
      scenarioId: normalizedChrome.scenarioId,
      ...compareSemanticTraceObservations(
        normalizedChrome,
        normalizedFirefox,
      ),
    });
  }
  environments.push({
    profile,
    chromeVersion: chrome.browserVersion,
    firefoxVersion: firefox.browserVersion,
  });
}

const expectedScenarios = [
  'detector-webgpu-failure-v1',
  'translation-retry-exhaustion-v1',
  'parallel-user-cancellation-v1',
  'host-disconnect-recovery-v1',
];
if (
  !requestedProfile
  && (
  comparisons.length !== expectedScenarios.length
  || expectedScenarios.some((scenarioId, index) =>
    comparisons[index]?.scenarioId !== scenarioId)
  )) {
  throw new Error(
    `Semantic trace scenario coverage drifted: ${JSON.stringify(comparisons)}`,
  );
}

console.log(JSON.stringify({ comparisons, environments }, null, 2));
