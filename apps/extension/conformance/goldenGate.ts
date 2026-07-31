import {
  compareGoldenTriangle,
  type GoldenTriangleComparisonReport,
  type GoldenTriangleInput,
} from './comparator';
import { GOLDEN_CONFORMANCE_MATRIX } from './scenarios';
import type { ConformanceScenario } from './types';

export type GoldenMatrixEntry = Omit<GoldenTriangleInput, 'sample'> & {
  scenarioId: string;
};

export type GoldenMatrixComparisonReport = {
  matches: true;
  samples: Readonly<Record<string, GoldenTriangleComparisonReport>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertComparableScenario(
  comparable: GoldenMatrixEntry['currentChrome'],
  comparableName: string,
  scenario: ConformanceScenario,
): void {
  if (!isRecord(comparable.strict)) {
    throw new TypeError(`${comparableName}.strict must be an object`);
  }
  const request = comparable.strict.request;
  const requestRecord = isRecord(request) ? request : null;
  const config = requestRecord?.config;
  const configRecord = isRecord(config) ? config : null;
  if (
    comparable.strict.scenarioId !== scenario.id
    || comparable.strict.resultStatus !== scenario.expectedStatus
    || requestRecord?.inputSha256 !== scenario.input.sha256
    || configRecord?.processMode !== scenario.config.processMode
  ) {
    throw new TypeError(
      `${comparableName} does not identify golden scenario ${scenario.id}`,
    );
  }
}

export function compareGoldenConformanceMatrix(
  entries: readonly GoldenMatrixEntry[],
): GoldenMatrixComparisonReport {
  const expectedIds = GOLDEN_CONFORMANCE_MATRIX.map((scenario) => scenario.id);
  const entriesById = new Map(entries.map((entry) => [entry.scenarioId, entry]));
  if (
    entriesById.size !== entries.length
    || entries.length !== expectedIds.length
    || expectedIds.some((id) => !entriesById.has(id))
  ) {
    throw new TypeError('golden matrix entries must contain each scenario exactly once');
  }

  const samples = Object.fromEntries(GOLDEN_CONFORMANCE_MATRIX.map((scenario) => {
    const entry = entriesById.get(scenario.id)!;
    assertComparableScenario(entry.chromeBaseline, 'chromeBaseline', scenario);
    assertComparableScenario(entry.firefoxBaseline, 'firefoxBaseline', scenario);
    assertComparableScenario(entry.currentChrome, 'currentChrome', scenario);
    assertComparableScenario(entry.currentFirefox, 'currentFirefox', scenario);
    return [scenario.id, compareGoldenTriangle({
      sample: {
        expectedStatus: scenario.expectedStatus,
        alpha: scenario.input.alpha,
      },
      chromeBaseline: entry.chromeBaseline,
      firefoxBaseline: entry.firefoxBaseline,
      currentChrome: entry.currentChrome,
      currentFirefox: entry.currentFirefox,
      processingRegions: entry.processingRegions,
      roiExpansionPixels: entry.roiExpansionPixels,
      budgets: entry.budgets,
    })];
  }));

  return { matches: true, samples };
}
