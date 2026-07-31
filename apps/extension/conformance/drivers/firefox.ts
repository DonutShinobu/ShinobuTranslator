import { resolve } from 'node:path';
import type {
  ConformanceDriverResult,
  ConformanceObservation,
} from '../types';
import { withFirefoxConformanceSession } from './firefoxSession';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const packagePath = resolve(
  repositoryRoot,
  'apps/extension/dist/conformance/firefox',
);

export async function runFirefoxConformanceDriver():
Promise<ConformanceDriverResult> {
  const result = await withFirefoxConformanceSession(
    packagePath,
    async ({ driver, handlesBefore }) => {
      try {
        await driver.wait(
          async () => await driver.executeScript<string>(
            'return document.body.dataset.state || "";',
          ) !== 'running',
          10 * 60_000,
          'Firefox conformance probe timed out.',
        );
      } catch (error) {
        const diagnostic = await driver.executeScript<string>(
          'return document.body.textContent || "";',
        );
        throw new Error(
          `Firefox conformance probe timed out: ${diagnostic || 'no progress'}`,
          { cause: error },
        );
      }
      const state = await driver.executeScript<string>(
        'return document.body.dataset.state || "";',
      );
      const payload = await driver.executeScript<string>(
        'return document.body.textContent || "";',
      );
      if (state !== 'complete' || !payload) {
        throw new Error(`Firefox conformance probe failed: ${payload || state}`);
      }
      if ((await driver.getAllWindowHandles()).length !== handlesBefore.length) {
        throw new Error(
          'Firefox conformance created a dedicated pipeline host page.',
        );
      }
      const observation = JSON.parse(payload) as ConformanceObservation;
      if (
        observation.browser !== 'firefox'
        || observation.host !== 'event-page-direct'
      ) {
        throw new Error('Firefox driver received the wrong host observation');
      }
      return observation;
    },
  );
  return {
    observation: result.value,
    browserVersion: result.browserVersion,
    packagePath,
  };
}
