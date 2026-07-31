import { resolve } from 'node:path';
import type {
  ConformanceDriverResult,
  ConformanceObservation,
} from '../types';
import { withChromeConformanceSession } from './chromeSession';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const packagePath = resolve(
  repositoryRoot,
  'apps/extension/dist/conformance/chrome',
);

export async function runChromeConformanceDriver():
Promise<ConformanceDriverResult> {
  const result = await withChromeConformanceSession(
    packagePath,
    async ({ page, cdp, extensionId }) => {
      try {
        await page.waitForFunction(
          () => document.body.dataset.state !== 'running',
        );
      } catch (error) {
        const diagnostic = await page.locator('body').textContent();
        throw new Error(
          `Chrome conformance probe timed out: ${diagnostic ?? 'no progress'}`,
          { cause: error },
        );
      }
      const state = await page.locator('body').getAttribute('data-state');
      const payload = await page.locator('body').textContent();
      if (state !== 'complete' || !payload) {
        const targets = await cdp.send('Target.getTargets');
        const extensionTargets = targets.targetInfos
          .filter((target) => target.url.includes(extensionId))
          .map((target) => ({
            type: target.type,
            url: target.url,
            attached: target.attached,
          }));
        throw new Error(
          `Chrome conformance probe failed: ${payload ?? state}; `
          + `extension targets=${JSON.stringify(extensionTargets)}`,
        );
      }
      const targets = await cdp.send('Target.getTargets');
      const offscreenTarget = targets.targetInfos.find((target) =>
        target.url === `chrome-extension://${extensionId}/offscreen.html`);
      if (!offscreenTarget) {
        throw new Error(
          'Chrome conformance did not traverse the packaged Offscreen host.',
        );
      }
      const observation = JSON.parse(payload) as ConformanceObservation;
      if (
        observation.browser !== 'chrome'
        || observation.host !== 'broker-offscreen'
      ) {
        throw new Error('Chrome driver received the wrong host observation');
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
