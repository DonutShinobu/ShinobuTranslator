import { resolve } from 'node:path';
import firefox from 'selenium-webdriver/firefox.js';
import type {
  SemanticConformanceDriverResult,
  SemanticTraceObservation,
} from '../types';
import type { SemanticConformanceProfile } from './chromeSemantic';
import {
  type FirefoxDriver,
  withFirefoxConformanceSession,
} from './firefoxSession';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

async function terminateBackground(
  driver: FirefoxDriver,
  addonId: string,
): Promise<number> {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeAsyncScript<{
      beforeContextId: number | null;
      contextId: number | null;
      state: string;
      error?: string;
    }>(`
      const extension = WebExtensionPolicy.getByID(arguments[0])?.extension;
      const complete = arguments[arguments.length - 1];
      if (!extension || typeof extension.terminateBackground !== 'function') {
        complete({ error: 'Event Page termination unavailable' });
        return;
      }
      const beforeContextId = extension.backgroundContext?.contextId ?? null;
      extension.terminateBackground({ disableResetIdleForTest: true }).then(
        () => complete({
          beforeContextId,
          contextId: extension.backgroundContext?.contextId ?? null,
          state: extension.backgroundState,
        }),
        (error) => complete({ error: String(error) }),
      );
    `, addonId);
    if (
      result.error
      || result.beforeContextId === null
      || result.contextId !== null
      || result.state !== 'stopped'
    ) {
      throw new Error(
        `Firefox Event Page did not terminate: ${JSON.stringify(result)}`,
      );
    }
    return result.beforeContextId;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function backgroundContextId(
  driver: FirefoxDriver,
  addonId: string,
): Promise<number | null> {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript<number | null>(`
      return WebExtensionPolicy.getByID(arguments[0])?.extension
        ?.backgroundContext?.contextId ?? null;
    `, addonId);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

function lifecycleObservation(
  observations: SemanticTraceObservation[],
): SemanticTraceObservation {
  const lifecycle = observations.find((observation) =>
    observation.scenarioId === 'host-disconnect-recovery-v1');
  if (!lifecycle) throw new Error('Firefox lifecycle trace is missing');
  return lifecycle;
}

export async function runFirefoxSemanticConformanceDriver(
  profile: SemanticConformanceProfile,
): Promise<SemanticConformanceDriverResult> {
  const packagePath = resolve(
    repositoryRoot,
    `apps/extension/dist/conformance/${profile}/firefox`,
  );
  const result = await withFirefoxConformanceSession(
    packagePath,
    async ({ driver, addonId, handlesBefore }) => {
      let previousContextId: number | undefined;
      if (profile === 'lifecycle') {
        await driver.wait(
          async () => await driver.executeScript<string>(
            'return document.body.dataset.barrier || "";',
          ) === 'runtime-result-produced',
          10 * 60_000,
          'Firefox lifecycle barrier was not reached.',
        );
        previousContextId = await terminateBackground(driver, addonId);
      }
      try {
        await driver.wait(
          async () => await driver.executeScript<string>(
            'return document.body.dataset.state || "";',
          ) !== 'running',
          10 * 60_000,
          'Firefox semantic probe timed out.',
        );
      } catch (error) {
        const diagnostic = await driver.executeScript<string>(
          'return document.body.textContent || "";',
        );
        throw new Error(
          `Firefox semantic probe timed out: ${diagnostic || 'no progress'}`,
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
        throw new Error(`Firefox semantic probe failed: ${payload || state}`);
      }
      if ((await driver.getAllWindowHandles()).length !== handlesBefore.length) {
        throw new Error('Firefox semantic probe created a dedicated host page');
      }
      const observations = JSON.parse(payload) as SemanticTraceObservation[];
      if (!Array.isArray(observations)) {
        throw new Error('Firefox semantic probe returned a non-array payload');
      }
      if (profile === 'lifecycle') {
        const rebuiltContextId = await backgroundContextId(driver, addonId);
        if (
          rebuiltContextId === null
          || rebuiltContextId === previousContextId
        ) {
          throw new Error('Firefox Event Page host was not rebuilt');
        }
        const lifecycle = lifecycleObservation(observations);
        lifecycle.hostRebuildCount = 1;
        lifecycle.executions[1]?.barriers.unshift('host-rebuilt');
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
