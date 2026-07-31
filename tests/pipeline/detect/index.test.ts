import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionReport } from '@shinobu/image-pipeline';
import type { PlatformProvider, PipelineImage } from '../../../src/runtime/platform';
import {
  ProviderExecutionError,
  type ProviderSessionResolver,
} from '../../../src/runtime/providerExecution';

const mocks = vi.hoisted(() => ({
  detectByOnnx: vi.fn(),
}));

vi.mock('../../../src/pipeline/detect/onnxDetect', () => ({
  detectByOnnx: mocks.detectByOnnx,
}));

import { detectTextRegionsWithMask } from '../../../src/pipeline/detect';

const image = {} as PipelineImage;
const platform = {} as PlatformProvider;
const resolver = {} as ProviderSessionResolver;
const region = {
  id: 'region-1',
  box: { x: 0, y: 0, width: 10, height: 20 },
  sourceText: '',
  translatedText: '',
};

function providerReport(satisfied: boolean): ProviderExecutionReport {
  return {
    schemaVersion: 1,
    contract: {
      id: 'test.detector-policy',
      version: 1,
    },
    model: 'detector',
    stage: 'detect',
    requiredProviders: ['wasm'],
    attempts: [
      {
        attempt: 1,
        provider: 'wasm',
        outcome: satisfied ? 'succeeded' : 'failed',
        reason: satisfied ? 'completed' : 'execution-failed',
      },
    ],
    finalProvider: satisfied ? 'wasm' : undefined,
    fallbackTrace: [],
    satisfied,
  };
}

describe('detectTextRegionsWithMask engine reporting', () => {
  beforeEach(() => {
    mocks.detectByOnnx.mockReset();
  });

  it('reports ONNX when the model succeeds', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockResolvedValue({
      regions: [region],
      rawMaskCanvas: null,
      actualProvider: 'wasm',
      providerReports: [report],
    });

    await expect(detectTextRegionsWithMask(image, platform, resolver)).resolves.toMatchObject({
      engine: 'onnx',
      actualProvider: 'wasm',
      providerReports: [report],
    });
  });

  it('returns an empty ONNX result without changing detection engines', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockResolvedValue({
      regions: [],
      rawMaskCanvas: null,
      actualProvider: 'wasm',
      providerReports: [report],
    });

    await expect(detectTextRegionsWithMask(image, platform, resolver)).resolves.toMatchObject({
      regions: [],
      engine: 'onnx',
      actualProvider: 'wasm',
      providerReports: [report],
    });
  });

  it('preserves a structured provider failure without exposing the raw runtime error', async () => {
    const report = providerReport(false);
    const providerError = new ProviderExecutionError(
      {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
        diagnostics: {
          contract: report.contract,
          model: report.model,
          report,
        },
      },
      report,
      new Error('GPU device secret detail'),
    );
    mocks.detectByOnnx.mockRejectedValue(providerError);

    await expect(detectTextRegionsWithMask(image, platform, resolver)).rejects.toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
        diagnostics: {
          contract: report.contract,
          model: 'detector',
          report,
        },
      },
      report,
    });
    expect(providerError.failure.diagnostics).not.toHaveProperty('message');
  });

  it('turns ONNX post-processing errors into a redacted structured detect failure', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockRejectedValue(Object.assign(
      new Error('raw tensor contents must stay private'),
      { providerReports: [report] },
    ));

    await expect(detectTextRegionsWithMask(image, platform, resolver)).rejects.toMatchObject({
      failure: {
        code: 'PIPELINE_DETECT_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.detect',
        diagnostics: {
          name: 'Error',
          providerReports: [report],
        },
      },
      providerReports: [report],
    });
    const error = await detectTextRegionsWithMask(image, platform, resolver).catch(
      (caught: unknown) => caught,
    ) as { failure: { diagnostics?: Record<string, unknown> } };
    expect(error.failure.diagnostics).not.toHaveProperty('message');
  });
});
