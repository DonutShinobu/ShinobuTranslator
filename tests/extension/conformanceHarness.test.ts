import { describe, expect, it } from 'vitest';
import {
  compareConformanceObservations,
  ConformanceMismatchError,
  normalizeConformanceObservation,
} from '../../apps/extension/conformance/harness';
import {
  SUCCESS_CONFORMANCE_SCENARIOS,
} from '../../apps/extension/conformance/scenarios';
import type {
  ConformanceObservation,
} from '../../apps/extension/conformance/types';
import type {
  ProviderExecutionModel,
  ProviderExecutionReport,
  ProviderExecutionStage,
} from '@shinobu/image-pipeline';

function providerReport(
  model: ProviderExecutionModel,
  stage: ProviderExecutionStage,
): ProviderExecutionReport {
  return {
    schemaVersion: 1,
    contract: {
      id: 'shinobu.webgpu-benchmark-provider-policy',
      version: 1,
    },
    model,
    stage,
    requiredProviders: ['webgpu'],
    attempts: [{
      attempt: 1,
      provider: 'webgpu',
      outcome: 'succeeded',
      reason: 'completed',
    }],
    finalProvider: 'webgpu',
    fallbackTrace: [],
    satisfied: true,
  };
}

const chromeRegionId = '11111111-1111-4111-8111-111111111111';
const firefoxRegionId = '22222222-2222-4222-8222-222222222222';
const chromeTranslationId = '33333333-3333-4333-8333-333333333333';
const firefoxTranslationId = '44444444-4444-4444-8444-444444444444';

function observation(
  browser: 'chrome' | 'firefox',
  regionId: string,
): ConformanceObservation {
  return {
    schemaVersion: 1,
    browser,
    host: browser === 'chrome'
      ? 'broker-offscreen'
      : 'event-page-direct',
    scenarioId: 'translate-vertical-sparse-v1',
    request: {
      inputSha256: 'fc0324b1adc4f4d4b9c7870643ca72bdd47cf04bf5308e0b607ec158cafc4daa',
      config: {
        sourceLang: 'ja',
        targetLang: 'zh-CHS',
        translator: 'google_web',
        llmProvider: 'deepseek',
        llmAuthMode: 'api_key',
        llmBaseUrl: 'https://api.deepseek.com/v1',
        llmModel: 'deepseek-chat',
        typesetDebug: false,
        eraseDebug: false,
        collectDebugLog: false,
        ocrEngine: 'paddleocr_v6_medium',
        processMode: 'translate',
      },
      workingCopy: { strategy: 'source-native' },
      fixedTranslationResponse: '固定译文',
      providerContract: {
        id: 'shinobu.webgpu-benchmark-provider-policy',
        version: 1,
      },
      resourceDigests: {
        font: 'font-sha256',
        modelManifest: 'model-manifest-sha256',
        modelChecksums: 'model-checksums-sha256',
      },
    },
    progress: [
      {
        stage: 'runtime-prepare',
        operation: 'runtime-prepare',
        detail: `${browser} timing detail`,
      },
      {
        stage: 'translate',
        operation: 'translate-plain',
        completed: 1,
        total: 1,
      },
      {
        stage: 'inpaint',
        operation: 'inpaint',
        completed: 1,
        total: 1,
      },
      {
        stage: 'finalize',
        operation: 'finalize',
        detail: `${browser} encoder detail`,
      },
      {
        stage: 'done',
        operation: 'done',
      },
    ],
    result: {
      status: 'completed',
      artifact: {
        contentType: 'image/png',
        width: 120,
        height: 80,
        channelOrder: 'rgba',
        colorSpace: 'srgb',
        decodedRgbaBase64: 'AA==',
        inputEquivalentToSource: false,
        byteLength: browser === 'chrome' ? 400 : 425,
        nativeBytesSha256: `${browser}-png-sha256`,
      },
      record: {
        schemaVersion: 2,
        workingCopy: {
          width: 120,
          height: 80,
          spec: { strategy: 'source-native' },
          sourceToWorkingCopy: { kind: 'identity' },
        },
        ocr: [
          {
            id: regionId,
            order: 0,
            box: {
              x: browser === 'chrome' ? 10 : 10.02,
              y: 12,
              width: 30,
              height: 20,
            },
            quad: [
              { x: 10, y: 12 },
              { x: 40, y: 12 },
              { x: 40, y: 32 },
              { x: 10, y: 32 },
            ],
            direction: 'v',
            confidence: browser === 'chrome' ? 0.98 : 0.9795,
            text: '原文',
          },
        ],
        translations: [
          {
            id: browser === 'chrome'
              ? chromeTranslationId
              : firefoxTranslationId,
            order: 0,
            box: { x: 10, y: 12, width: 30, height: 20 },
            direction: 'v',
            sourceText: '原文',
            translatedText: '固定译文',
            translatedColumns: ['固定', '译文'],
          },
        ],
      },
      typesetMetrics: {
        font: {
          'typeset[0].initialFontSize': 24,
          'typeset[0].fittedFontSize': browser === 'chrome' ? 22 : 22.25,
        },
        layout: {
          'typeset[0].layoutContentHeight': browser === 'chrome' ? 48 : 48.25,
        },
      },
      providerReports: [
        providerReport('detector', 'detect'),
        providerReport('bubble', 'bubble'),
        providerReport('paddleocr_v6_medium_rec', 'ocr'),
        providerReport('inpaint', 'inpaint'),
      ],
    },
    failure: null,
    cancellation: null,
    finalizationCount: 1,
    commitCount: 1,
  };
}

describe('real-host conformance harness', () => {
  it('extends the successful sample assigned to issue #54 into the golden matrix', () => {
    expect(SUCCESS_CONFORMANCE_SCENARIOS).toHaveLength(9);
    expect(SUCCESS_CONFORMANCE_SCENARIOS[0]).toMatchObject({
      id: 'translate-vertical-sparse-v1',
      config: {
        processMode: 'translate',
      },
      workingCopy: { strategy: 'source-native' },
      providerPolicy: {
        contract: {
          id: 'shinobu.webgpu-benchmark-provider-policy',
          version: 1,
        },
      },
    });
  });

  it('normalizes UUID references and explicitly excludes tolerated fields', () => {
    const chrome = normalizeConformanceObservation(
      observation('chrome', chromeRegionId),
    );
    const firefox = normalizeConformanceObservation(
      observation('firefox', firefoxRegionId),
    );

    expect(chrome.record.ocr[0]?.id).toBe('region-1');
    expect(chrome.record.translations[0]?.id).toBe('region-2');
    expect(chrome.excludedFields).toEqual([
      'browser',
      'host',
      'progress[].detail',
      'result.artifact.byteLength',
      'result.artifact.nativeBytesSha256',
      'result.stageTimings',
      'failure.underlyingErrorText',
      'failure.stack',
    ]);
    expect(compareConformanceObservations(chrome, firefox)).toEqual({
      matches: true,
    });
  });

  it('compares parallel progress by stream while keeping each stream ordered', () => {
    const chromeObservation = observation('chrome', chromeRegionId);
    const firefoxObservation = observation('firefox', firefoxRegionId);
    firefoxObservation.progress = [
      firefoxObservation.progress[0]!,
      firefoxObservation.progress[2]!,
      firefoxObservation.progress[1]!,
      firefoxObservation.progress[3]!,
      firefoxObservation.progress[4]!,
    ];

    expect(compareConformanceObservations(
      normalizeConformanceObservation(chromeObservation),
      normalizeConformanceObservation(firefoxObservation),
    )).toEqual({ matches: true });
  });

  it('fails closed when a newly observed field is unclassified', () => {
    const withUnknownField = observation(
      'chrome',
      chromeRegionId,
    ) as ConformanceObservation & { unexpected?: string };
    withUnknownField.unexpected = 'unclassified';

    expect(() =>
      normalizeConformanceObservation(withUnknownField)).toThrow(
      /unclassified observation field.*unexpected/iu,
    );
  });

  it('rejects discrete result drift and invalid finalization or commit counts', () => {
    const chrome = normalizeConformanceObservation(
      observation('chrome', chromeRegionId),
    );
    const firefoxInput = observation('firefox', firefoxRegionId);
    firefoxInput.result!.artifact.width += 1;
    const firefox = normalizeConformanceObservation(firefoxInput);

    expect(() =>
      compareConformanceObservations(chrome, firefox)).toThrow(
      ConformanceMismatchError,
    );

    const duplicateCommit = observation('chrome', chromeRegionId);
    duplicateCommit.commitCount = 2;
    expect(() =>
      normalizeConformanceObservation(duplicateCommit)).toThrow(
      /commit exactly once/iu,
    );
  });

  it('rejects a non-UUID region identifier before canonicalizing references', () => {
    expect(() =>
      normalizeConformanceObservation(
        observation('chrome', 'not-a-random-uuid'),
      )).toThrow(/region id must be a UUID/iu);
  });

  it('requires a successful WebGPU report for all four model stages', () => {
    const missingInpaint = observation('chrome', chromeRegionId);
    missingInpaint.result!.providerReports =
      missingInpaint.result!.providerReports.slice(0, -1);

    expect(() =>
      normalizeConformanceObservation(missingInpaint)).toThrow(
      /expected reached stages/iu,
    );
  });

  it('requires the committed record to contain the fixed translation response', () => {
    const untranslated = observation('chrome', chromeRegionId);
    untranslated.result!.record.translations[0]!.translatedText = '';

    expect(() =>
      normalizeConformanceObservation(untranslated)).toThrow(
      /fixed translation response/iu,
    );
  });

  it('fails closed when a nested numeric field is unclassified', () => {
    const withUnknownBoxField = observation('chrome', chromeRegionId);
    const box = withUnknownBoxField.result!.record.ocr[0]!.box as {
      x: number;
      y: number;
      width: number;
      height: number;
      angle?: number;
    };
    box.angle = 4;

    expect(() => normalizeConformanceObservation(withUnknownBoxField))
      .toThrow(/unclassified observation field.*box\.angle/iu);
  });

  it('accepts an input-equivalent no-text sample with only its reached WebGPU stage', () => {
    const noText = observation('chrome', chromeRegionId);
    noText.scenarioId = 'no-text-transparent-png-v1';
    noText.request.inputSha256 =
      '77badf0f9c5d4da8655548fcc6d5b6c94b2a598aa4539270c18f6525fd50e1fd';
    noText.request.fixedTranslationResponse = '';
    noText.request.config.typesetDebug = false;
    noText.result!.status = 'no-translatable-text';
    noText.result!.record.ocr = [];
    noText.result!.record.translations = [];
    noText.result!.typesetMetrics = { font: {}, layout: {} };
    noText.result!.providerReports = [providerReport('detector', 'detect')];
    noText.result!.artifact.inputEquivalentToSource = true;

    const normalized = normalizeConformanceObservation(noText);
    expect(normalized.resultStatus).toBe('no-translatable-text');
    expect(normalized.record.ocr).toEqual([]);
    expect(normalized.record.translations).toEqual([]);
    expect(normalized.numeric).toEqual({
      confidence: {},
      geometry: {},
      quad: {},
      font: {},
      layout: {},
    });
  });

  it('fails closed when a typeset metric category is not classified', () => {
    const withUnknownMetricCategory = observation('chrome', chromeRegionId);
    const metrics = withUnknownMetricCategory.result!.typesetMetrics as
      NonNullable<ConformanceObservation['result']>['typesetMetrics']
      & { glyphRaster?: Record<string, number> };
    metrics.glyphRaster = { unexpected: 1 };

    expect(() => normalizeConformanceObservation(withUnknownMetricCategory))
      .toThrow(/unclassified observation field.*glyphRaster/iu);
  });
});
