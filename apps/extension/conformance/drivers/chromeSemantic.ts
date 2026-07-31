import { resolve } from 'node:path';
import type {
  SemanticConformanceDriverResult,
  SemanticTraceObservation,
} from '../types';
import { withChromeConformanceSession } from './chromeSession';

export type SemanticConformanceProfile =
  | 'detector'
  | 'translation'
  | 'lifecycle';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

function packagePathFor(profile: SemanticConformanceProfile): string {
  return resolve(
    repositoryRoot,
    `apps/extension/dist/conformance/${profile}/chrome`,
  );
}

function lifecycleObservation(
  observations: SemanticTraceObservation[],
): SemanticTraceObservation {
  const lifecycle = observations.find((observation) =>
    observation.scenarioId === 'host-disconnect-recovery-v1');
  if (!lifecycle) throw new Error('Chrome lifecycle trace is missing');
  return lifecycle;
}

export async function runChromeSemanticConformanceDriver(
  profile: SemanticConformanceProfile,
): Promise<SemanticConformanceDriverResult> {
  const packagePath = packagePathFor(profile);
  const result = await withChromeConformanceSession(
    packagePath,
    async ({ page, cdp, extensionId }) => {
      let terminatedTargetId: string | undefined;
      if (profile === 'lifecycle') {
        await page.waitForFunction(
          () => document.body.dataset.barrier === 'runtime-result-produced',
        );
        const targets = await cdp.send('Target.getTargets');
        const offscreen = targets.targetInfos.find((target) =>
          target.url === `chrome-extension://${extensionId}/offscreen.html`);
        if (!offscreen) {
          throw new Error('Chrome lifecycle barrier has no Offscreen host');
        }
        terminatedTargetId = offscreen.targetId;
        const closed = await cdp.send('Target.closeTarget', {
          targetId: terminatedTargetId,
        });
        if (!closed.success) {
          throw new Error('Chrome Offscreen host did not close at the barrier');
        }
      }
      try {
        await page.waitForFunction(
          () => document.body.dataset.state !== 'running',
        );
      } catch (error) {
        const diagnostic = await page.locator('body').textContent();
        throw new Error(
          `Chrome semantic probe timed out: ${diagnostic ?? 'no progress'}`,
          { cause: error },
        );
      }
      const state = await page.locator('body').getAttribute('data-state');
      const payload = await page.locator('body').textContent();
      if (state !== 'complete' || !payload) {
        throw new Error(
          `Chrome semantic probe failed: ${payload ?? state ?? 'no payload'}`,
        );
      }
      const observations = JSON.parse(payload) as SemanticTraceObservation[];
      if (!Array.isArray(observations)) {
        throw new Error('Chrome semantic probe returned a non-array payload');
      }
      if (profile === 'lifecycle') {
        const targets = await cdp.send('Target.getTargets');
        const rebuilt = targets.targetInfos.find((target) =>
          target.url === `chrome-extension://${extensionId}/offscreen.html`
          && target.targetId !== terminatedTargetId);
        if (!rebuilt) throw new Error('Chrome Offscreen host was not rebuilt');
        const lifecycle = lifecycleObservation(observations);
        lifecycle.hostRebuildCount = 1;
        lifecycle.executions[1]?.barriers.unshift('host-rebuilt');
      } else {
        const targets = await cdp.send('Target.getTargets');
        if (!targets.targetInfos.some((target) =>
          target.url === `chrome-extension://${extensionId}/offscreen.html`)) {
          throw new Error('Chrome semantic probe bypassed the Offscreen host');
        }
      }
      return observations;
    },
  );
  return {
    observations: result.value,
    browserVersion: result.browserVersion,
    packagePath,
  };
}
