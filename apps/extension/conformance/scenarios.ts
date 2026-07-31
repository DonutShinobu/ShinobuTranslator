import type {
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import {
  WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
} from '@shinobu/image-pipeline';
import type {
  ConformanceScenario,
} from './types';

export const GOLDEN_CONFORMANCE_MATRIX_VERSION = 1 as const;

export const WEBGPU_CONFORMANCE_PROVIDER_POLICY:
ProviderExecutionPolicy = WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY;

const translateConfig = Object.freeze({
    sourceLang: 'ja',
    targetLang: 'zh-CHS',
    translator: 'google_web',
    llmProvider: 'deepseek',
    llmAuthMode: 'api_key',
    llmBaseUrl: 'https://api.deepseek.com/v1',
    llmModel: 'deepseek-chat',
    typesetDebug: true,
    eraseDebug: false,
    collectDebugLog: false,
    ocrEngine: 'paddleocr_v6_medium',
    processMode: 'translate',
});

const resourcePaths = Object.freeze({
  font: 'fonts/SourceHanSansCN-VF.ttf.woff2',
  modelManifest: 'models/models.json',
  modelChecksums: 'models/models.sha256',
});
const workingCopy = Object.freeze({ strategy: 'source-native' } as const);
const allProviderTargets = Object.freeze([
  'detector:detect',
  'bubble:bubble',
  'paddleocr_v6_medium_rec:ocr',
  'inpaint:inpaint',
]);

type ScenarioInput = ConformanceScenario['input'];
type ScenarioOptions = Pick<
  ConformanceScenario,
  | 'id'
  | 'expectedStatus'
  | 'coverage'
  | 'requiresInputEquivalentResult'
  | 'expectedProviderTargets'
> & {
  input: ScenarioInput;
  processMode?: 'translate' | 'erase';
};

function scenario(options: ScenarioOptions): ConformanceScenario {
  return Object.freeze({
    matrixVersion: GOLDEN_CONFORMANCE_MATRIX_VERSION,
    id: options.id,
    input: Object.freeze(options.input),
    expectedStatus: options.expectedStatus,
    coverage: Object.freeze([...options.coverage]),
    requiresInputEquivalentResult: options.requiresInputEquivalentResult,
    expectedProviderTargets: Object.freeze([...options.expectedProviderTargets]),
    config: Object.freeze({
      ...translateConfig,
      processMode: options.processMode ?? 'translate',
      typesetDebug: (options.processMode ?? 'translate') === 'translate'
        && options.expectedStatus === 'completed',
    }),
    workingCopy,
    fixedTranslationResponse: options.processMode === 'erase'
      || options.expectedStatus === 'no-translatable-text'
      ? ''
      : '固定译文',
    providerPolicy: WEBGPU_CONFORMANCE_PROVIDER_POLICY,
    resourcePaths,
  });
}

export const GOLDEN_CONFORMANCE_MATRIX:
readonly ConformanceScenario[] = Object.freeze([
  scenario({
    id: 'translate-vertical-sparse-v1',
    input: {
      path: 'conformance-inputs/v1/translate-vertical-sparse.png',
      contentType: 'image/png',
      sha256: 'fc0324b1adc4f4d4b9c7870643ca72bdd47cf04bf5308e0b607ec158cafc4daa',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['vertical'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'translate-horizontal-jpeg-v1',
    input: {
      path: 'conformance-inputs/v1/translate-horizontal.jpg',
      contentType: 'image/jpeg',
      sha256: 'e2769746de40205f4a496fba5e16e003d86606caae5cadd2f0d2ebbf0d291c91',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['horizontal'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'translate-mixed-dense-v1',
    input: {
      path: 'conformance-inputs/v1/translate-mixed-dense.png',
      contentType: 'image/png',
      sha256: '136160082dc051da811ae9f202085614bddb223506fa2593363940b1e38a0f4c',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['mixed'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'translate-irregular-quad-v1',
    input: {
      path: 'conformance-inputs/v1/translate-irregular-quad.png',
      contentType: 'image/png',
      sha256: 'd4a27fe134cc8af172ed868df3a279564ca9694d3187e65cf3673bd7c583778a',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['irregular-quad'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'translate-font-punctuation-latin-v1',
    input: {
      path: 'conformance-inputs/v1/translate-font-punctuation-latin.png',
      contentType: 'image/png',
      sha256: 'e76f1c06cdf650dfd85246529170471fd4709e7fb5fbf78dc3dd1a62dcb7e8c8',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['font-punctuation-latin'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'translate-long-high-resolution-v1',
    input: {
      path: 'conformance-inputs/v1/translate-long-high-resolution.png',
      contentType: 'image/png',
      sha256: '3d0525663afce3f3f52c6495a681c15242371c872e7c8fa2a1ea931883a95eb4',
      alpha: 'opaque',
    },
    expectedStatus: 'completed',
    coverage: ['long-high-resolution'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'erase-complete-v1',
    input: {
      path: 'conformance-inputs/v1/erase-complete.png',
      contentType: 'image/png',
      sha256: '5bbc60ecfa5376def64a886193312e4672cfcaf828c99397d008264cc680ae54',
      alpha: 'opaque',
    },
    processMode: 'erase',
    expectedStatus: 'completed',
    coverage: ['erase'],
    requiresInputEquivalentResult: false,
    expectedProviderTargets: allProviderTargets,
  }),
  scenario({
    id: 'no-text-opaque-jpeg-v1',
    input: {
      path: 'conformance-inputs/v1/no-text-opaque.jpg',
      contentType: 'image/jpeg',
      sha256: '8e20263f6d0d3ed88670074d46085576762f66986fbb1dac5f60f8ab6e964384',
      alpha: 'opaque',
    },
    expectedStatus: 'no-translatable-text',
    coverage: ['no-text-opaque'],
    requiresInputEquivalentResult: true,
    expectedProviderTargets: ['detector:detect'],
  }),
  scenario({
    id: 'no-text-transparent-png-v1',
    input: {
      path: 'conformance-inputs/v1/no-text-transparent.png',
      contentType: 'image/png',
      sha256: '77badf0f9c5d4da8655548fcc6d5b6c94b2a598aa4539270c18f6525fd50e1fd',
      alpha: 'transparent',
    },
    expectedStatus: 'no-translatable-text',
    coverage: ['no-text-transparent'],
    requiresInputEquivalentResult: true,
    expectedProviderTargets: ['detector:detect'],
  }),
]);

export const SUCCESS_CONFORMANCE_SCENARIOS = GOLDEN_CONFORMANCE_MATRIX;

export function successfulConformanceScenario(): ConformanceScenario {
  return GOLDEN_CONFORMANCE_MATRIX[0]!;
}

export function conformanceScenarioById(
  id: ConformanceScenario['id'],
): ConformanceScenario {
  const result = GOLDEN_CONFORMANCE_MATRIX.find((entry) => entry.id === id);
  if (!result) throw new TypeError(`unknown conformance scenario ${id}`);
  return result;
}
