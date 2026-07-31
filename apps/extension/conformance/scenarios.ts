import type {
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import {
  WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
} from '@shinobu/image-pipeline';
import type {
  ConformanceScenario,
} from './types';

export const WEBGPU_CONFORMANCE_PROVIDER_POLICY:
ProviderExecutionPolicy = WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY;

const successfulTranslateScenario: ConformanceScenario = Object.freeze({
  id: 'successful-translate-v1',
  input: Object.freeze({
    path: 'conformance-input.png',
    contentType: 'image/png',
  }),
  config: Object.freeze({
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
  }),
  workingCopy: Object.freeze({ strategy: 'source-native' }),
  fixedTranslationResponse: '固定译文',
  providerPolicy: WEBGPU_CONFORMANCE_PROVIDER_POLICY,
  resourcePaths: Object.freeze({
    font: 'fonts/SourceHanSansCN-VF.ttf.woff2',
    modelManifest: 'models/models.json',
    modelChecksums: 'models/models.sha256',
  }),
});

export const SUCCESS_CONFORMANCE_SCENARIOS:
readonly ConformanceScenario[] = Object.freeze([
  successfulTranslateScenario,
]);

export function successfulConformanceScenario(): ConformanceScenario {
  return SUCCESS_CONFORMANCE_SCENARIOS[0]!;
}
