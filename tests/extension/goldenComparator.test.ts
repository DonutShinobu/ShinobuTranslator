import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONFORMANCE_FIELD_CLASSIFICATION,
  compareGoldenTriangle,
  compareNumericObservations,
  compareRgbaImages,
  NumericToleranceExceededError,
  RgbaToleranceExceededError,
  type DecodedRgbaImage,
  type GoldenComparable,
  type GoldenEdgeBudget,
  type NumericObservation,
  type RgbaMetricBudget,
} from '../../apps/extension/conformance/comparator';
import {
  compareGoldenConformanceMatrix,
  type GoldenMatrixEntry,
} from '../../apps/extension/conformance/goldenGate';
import {
  GOLDEN_CONFORMANCE_MATRIX,
  GOLDEN_CONFORMANCE_MATRIX_VERSION,
} from '../../apps/extension/conformance/scenarios';

const numericBudget = {
  confidence: 0.001,
  geometry: 0.05,
  quad: 0.05,
  font: 0.5,
  layout: 0.5,
} as const;

const rgbaMetricBudget: RgbaMetricBudget = {
  maxMae: 2,
  maxP99: 8,
  maxP999: 16,
  maxWorstTileMae: 3,
  cumulativeMinimums: [
    { differenceAtMost: 0, minimumRatio: 0.5 },
    { differenceAtMost: 8, minimumRatio: 0.99 },
  ],
};

const edgeBudget: GoldenEdgeBudget = {
  numeric: numericBudget,
  rgba: {
    fullImage: rgbaMetricBudget,
    roi: {
      ...rgbaMetricBudget,
      maxMae: 4,
      maxWorstTileMae: 4,
      cumulativeMinimums: [
        { differenceAtMost: 8, minimumRatio: 0.99 },
      ],
    },
    alpha: rgbaMetricBudget,
  },
};

function numeric(overrides: Partial<NumericObservation> = {}): NumericObservation {
  return {
    confidence: { 'ocr[0].confidence': 0.98 },
    geometry: { 'ocr[0].box.x': 10 },
    quad: { 'ocr[0].quad[0].x': 10 },
    font: { 'typeset[0].fittedFontSize': 24 },
    layout: { 'typeset[0].layoutContentHeight': 48 },
    ...overrides,
  };
}

function rgba(values: number[], width = 2, height = 2): DecodedRgbaImage {
  return {
    width,
    height,
    channelOrder: 'rgba',
    colorSpace: 'srgb',
    data: Uint8Array.from(values),
  };
}

const black2x2 = rgba([
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
]);

function comparable(
  strict: unknown,
  numericObservation = numeric(),
  image = black2x2,
): GoldenComparable {
  return { strict, numeric: numericObservation, rgba: image };
}

describe('nine-sample golden conformance matrix', () => {
  it('is versioned and owns exactly the required translate, erase, and no-text samples', () => {
    expect(GOLDEN_CONFORMANCE_MATRIX_VERSION).toBe(1);
    expect(GOLDEN_CONFORMANCE_MATRIX).toHaveLength(9);
    expect(GOLDEN_CONFORMANCE_MATRIX.map((scenario) => scenario.id))
      .toEqual([
        'translate-vertical-sparse-v1',
        'translate-horizontal-jpeg-v1',
        'translate-mixed-dense-v1',
        'translate-irregular-quad-v1',
        'translate-font-punctuation-latin-v1',
        'translate-long-high-resolution-v1',
        'erase-complete-v1',
        'no-text-opaque-jpeg-v1',
        'no-text-transparent-png-v1',
      ]);

    const completedTranslate = GOLDEN_CONFORMANCE_MATRIX.filter(
      (scenario) => scenario.expectedStatus === 'completed'
        && scenario.config.processMode === 'translate',
    );
    const completedErase = GOLDEN_CONFORMANCE_MATRIX.filter(
      (scenario) => scenario.expectedStatus === 'completed'
        && scenario.config.processMode === 'erase',
    );
    const noText = GOLDEN_CONFORMANCE_MATRIX.filter(
      (scenario) => scenario.expectedStatus === 'no-translatable-text',
    );
    expect(completedTranslate).toHaveLength(6);
    expect(completedErase).toHaveLength(1);
    expect(noText).toHaveLength(2);
    expect(noText.map((scenario) => [
      scenario.input.contentType,
      scenario.input.alpha,
    ])).toEqual([
      ['image/jpeg', 'opaque'],
      ['image/png', 'transparent'],
    ]);
    expect(noText.every((scenario) => scenario.requiresInputEquivalentResult))
      .toBe(true);
  });

  it('covers every required normal-result stress dimension with hash-locked inputs', () => {
    const normalCoverage = new Set(
      GOLDEN_CONFORMANCE_MATRIX
        .filter((scenario) => scenario.expectedStatus === 'completed')
        .flatMap((scenario) => scenario.coverage),
    );
    expect(normalCoverage).toEqual(new Set([
      'vertical',
      'horizontal',
      'mixed',
      'irregular-quad',
      'font-punctuation-latin',
      'long-high-resolution',
      'erase',
    ]));
    expect(GOLDEN_CONFORMANCE_MATRIX.every((scenario) =>
      /^[0-9a-f]{64}$/u.test(scenario.input.sha256))).toBe(true);
    for (const scenario of GOLDEN_CONFORMANCE_MATRIX) {
      const fixture = resolve(
        'apps/extension/conformance/fixtures/inputs/v1',
        scenario.input.path.split('/').at(-1)!,
      );
      expect(createHash('sha256').update(readFileSync(fixture)).digest('hex'))
        .toBe(scenario.input.sha256);
    }
  });
});

describe('explicit conformance field classification', () => {
  it('classifies strict, normalized, tolerated, and excluded observations', () => {
    expect(CONFORMANCE_FIELD_CLASSIFICATION).toEqual({
      strict: expect.arrayContaining([
        'schemaVersion',
        'scenarioId',
        'result.status',
        'result.record.schemaVersion',
        'result.record.ocr[].text',
        'result.record.translations[].translatedText',
        'result.providerReports[]',
      ]),
      normalized: [
        'result.record.ocr[].id',
        'result.record.translations[].id',
      ],
      tolerance: expect.arrayContaining([
        'result.record.ocr[].confidence',
        'result.record.*[].box',
        'result.record.*[].quad',
        'result.typesetMetrics.font',
        'result.typesetMetrics.layout',
        'result.artifact.decodedRgbaBase64',
      ]),
      excluded: expect.arrayContaining([
        'browser',
        'host',
        'progress[].detail',
        'result.artifact.nativeBytesSha256',
        'result.artifact.byteLength',
        'result.stageTimings',
        'failure.underlyingErrorText',
      ]),
    });
    expect(CONFORMANCE_FIELD_CLASSIFICATION.excluded.join(' '))
      .not.toMatch(/ssim|perceptual|subjective/iu);
  });
});

describe('numeric golden comparator', () => {
  it('covers confidence, geometry, quad, font, and layout with absolute budgets', () => {
    const report = compareNumericObservations(
      numeric(),
      numeric({
        confidence: { 'ocr[0].confidence': 0.9795 },
        geometry: { 'ocr[0].box.x': 10.02 },
        quad: { 'ocr[0].quad[0].x': 10.01 },
        font: { 'typeset[0].fittedFontSize': 24.25 },
        layout: { 'typeset[0].layoutContentHeight': 48.25 },
      }),
      numericBudget,
    );

    expect(report.matches).toBe(true);
    expect(report.maximumAbsoluteDifferences).toEqual({
      confidence: expect.closeTo(0.0005),
      geometry: expect.closeTo(0.02),
      quad: expect.closeTo(0.01),
      font: 0.25,
      layout: 0.25,
    });
  });

  it('fails closed for missing metric keys and over-budget values', () => {
    expect(() => compareNumericObservations(
      numeric(),
      numeric({ confidence: {} }),
      numericBudget,
    )).toThrow(/metric keys differ.*confidence/iu);

    expect(() => compareNumericObservations(
      numeric(),
      numeric({ font: { 'typeset[0].fittedFontSize': 25 } }),
      numericBudget,
    )).toThrow(NumericToleranceExceededError);
  });
});

describe('decoded RGBA golden comparator', () => {
  it('reports full-image and fixed-ROI histograms, MAE, P99, P99.9, and worst tile', () => {
    const candidate = rgba([
      0, 0, 0, 255,
      1, 2, 3, 255,
      0, 0, 0, 255,
      4, 5, 6, 254,
    ]);
    const report = compareRgbaImages(
      black2x2,
      candidate,
      [{ x: 1, y: 0, width: 1, height: 2 }],
      edgeBudget.rgba,
    );

    expect(report.matches).toBe(true);
    expect(report.fullImage.histogram).toHaveLength(256);
    expect(report.fullImage.mae).toBeCloseTo(21 / 12);
    expect(report.fullImage.p99).toBe(6);
    expect(report.fullImage.p999).toBe(6);
    expect(report.fullImage.worstTileMae).toBeCloseTo(21 / 12);
    expect(report.roi.sampleCount).toBe(6);
    expect(report.roi.mae).toBeCloseTo(21 / 6);
    expect(report.alpha.mae).toBeCloseTo(1 / 4);
  });

  it('judges alpha independently and can require exact transparent alpha', () => {
    const transparent = rgba([
      10, 20, 30, 0,
      10, 20, 30, 64,
      10, 20, 30, 128,
      10, 20, 30, 255,
    ]);
    const alphaDrift = rgba([
      10, 20, 30, 1,
      10, 20, 30, 64,
      10, 20, 30, 128,
      10, 20, 30, 255,
    ]);
    expect(() => compareRgbaImages(
      transparent,
      alphaDrift,
      [],
      { ...edgeBudget.rgba, strictAlpha: true },
    )).toThrow(RgbaToleranceExceededError);
  });

  it('fails before metrics when dimensions, channel order, or color space differ', () => {
    expect(() => compareRgbaImages(
      black2x2,
      { ...black2x2, colorSpace: 'display-p3' } as unknown as DecodedRgbaImage,
      [],
      edgeBudget.rgba,
    )).toThrow(/color space/iu);
  });
});

describe('golden triangle comparator', () => {
  it('requires Chrome baseline, Firefox baseline, and current cross-browser edges', () => {
    const strict = { status: 'completed', text: '固定译文' };
    const comparison = compareGoldenTriangle({
      sample: { expectedStatus: 'completed', alpha: 'opaque' },
      chromeBaseline: comparable(strict),
      firefoxBaseline: comparable(strict),
      currentChrome: comparable(strict),
      currentFirefox: comparable(strict),
      processingRegions: [{ x: 1, y: 1, width: 1, height: 1 }],
      roiExpansionPixels: 1,
      budgets: {
        chromeBaseline: edgeBudget,
        firefoxBaseline: edgeBudget,
        crossBrowser: edgeBudget,
      },
    });

    expect(comparison.matches).toBe(true);
    expect(comparison.edges.crossBrowser.rgba.roi.sampleCount).toBe(12);
    expect(Object.keys(comparison.edges)).toEqual([
      'chromeBaseline',
      'firefoxBaseline',
      'crossBrowser',
    ]);
  });

  it('blocks common drift even when the two current browsers still match', () => {
    const baseline = { status: 'completed', text: '固定译文' };
    const jointlyDrifted = { status: 'completed', text: '共同漂移' };
    expect(() => compareGoldenTriangle({
      sample: { expectedStatus: 'completed', alpha: 'opaque' },
      chromeBaseline: comparable(baseline),
      firefoxBaseline: comparable(baseline),
      currentChrome: comparable(jointlyDrifted),
      currentFirefox: comparable(jointlyDrifted),
      processingRegions: [{ x: 0, y: 0, width: 2, height: 2 }],
      roiExpansionPixels: 0,
      budgets: {
        chromeBaseline: edgeBudget,
        firefoxBaseline: edgeBudget,
        crossBrowser: edgeBudget,
      },
    })).toThrow(/chromeBaseline.*strict/iu);
  });

  it('forces exact alpha on all edges for the transparent no-text sample', () => {
    const transparentBaseline = rgba([
      0, 0, 0, 0,
      0, 0, 0, 64,
      0, 0, 0, 128,
      0, 0, 0, 255,
    ]);
    const alphaDrift = rgba([
      0, 0, 0, 1,
      0, 0, 0, 64,
      0, 0, 0, 128,
      0, 0, 0, 255,
    ]);
    const strict = { status: 'no-translatable-text' };
    expect(() => compareGoldenTriangle({
      sample: { expectedStatus: 'no-translatable-text', alpha: 'transparent' },
      chromeBaseline: comparable(strict, numeric(), transparentBaseline),
      firefoxBaseline: comparable(strict, numeric(), transparentBaseline),
      currentChrome: comparable(strict, numeric(), alphaDrift),
      currentFirefox: comparable(strict, numeric(), alphaDrift),
      processingRegions: [],
      roiExpansionPixels: 0,
      budgets: {
        chromeBaseline: edgeBudget,
        firefoxBaseline: edgeBudget,
        crossBrowser: edgeBudget,
      },
    })).toThrow(RgbaToleranceExceededError);
  });

  it('fails closed when a completed sample has no processing ROI', () => {
    const strict = { status: 'completed' };
    expect(() => compareGoldenTriangle({
      sample: { expectedStatus: 'completed', alpha: 'opaque' },
      chromeBaseline: comparable(strict),
      firefoxBaseline: comparable(strict),
      currentChrome: comparable(strict),
      currentFirefox: comparable(strict),
      processingRegions: [],
      roiExpansionPixels: 0,
      budgets: {
        chromeBaseline: edgeBudget,
        firefoxBaseline: edgeBudget,
        crossBrowser: edgeBudget,
      },
    })).toThrow(/require processing regions/iu);

    expect(() => compareGoldenTriangle({
      sample: { expectedStatus: 'completed', alpha: 'opaque' },
      chromeBaseline: comparable(strict),
      firefoxBaseline: comparable(strict),
      currentChrome: comparable(strict),
      currentFirefox: comparable(strict),
      processingRegions: [{ x: 10, y: 10, width: 1, height: 1 }],
      roiExpansionPixels: 0,
      budgets: {
        chromeBaseline: edgeBudget,
        firefoxBaseline: edgeBudget,
        crossBrowser: edgeBudget,
      },
    })).toThrow(/ROI does not intersect/iu);
  });

  it('runs the triangular comparator for every matrix sample exactly once', () => {
    const entries: GoldenMatrixEntry[] = GOLDEN_CONFORMANCE_MATRIX.map(
      (scenario) => {
        const strict = {
          scenarioId: scenario.id,
          resultStatus: scenario.expectedStatus,
          request: {
            inputSha256: scenario.input.sha256,
            config: { processMode: scenario.config.processMode },
          },
        };
        return {
          scenarioId: scenario.id,
          chromeBaseline: comparable(strict),
          firefoxBaseline: comparable(strict),
          currentChrome: comparable(strict),
          currentFirefox: comparable(strict),
          processingRegions: scenario.expectedStatus === 'completed'
            ? [{ x: 0, y: 0, width: 2, height: 2 }]
            : [],
          roiExpansionPixels: 0,
          budgets: {
            chromeBaseline: edgeBudget,
            firefoxBaseline: edgeBudget,
            crossBrowser: edgeBudget,
          },
        };
      },
    );

    const report = compareGoldenConformanceMatrix(entries);
    expect(report.matches).toBe(true);
    expect(Object.keys(report.samples)).toEqual(
      GOLDEN_CONFORMANCE_MATRIX.map((scenario) => scenario.id),
    );
    expect(() => compareGoldenConformanceMatrix(entries.slice(1)))
      .toThrow(/each scenario exactly once/iu);

    const relabeled = structuredClone(entries) as GoldenMatrixEntry[];
    relabeled[1]!.chromeBaseline.strict = entries[0]!.chromeBaseline.strict;
    expect(() => compareGoldenConformanceMatrix(relabeled))
      .toThrow(/does not identify golden scenario/iu);
  });
});
