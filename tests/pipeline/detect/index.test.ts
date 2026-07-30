import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionReport } from '@shinobu/image-pipeline';
import type { PlatformProvider, PipelineImage } from '../../../src/runtime/platform';
import { ProviderExecutionError } from '../../../src/runtime/providerExecution';

const mocks = vi.hoisted(() => ({
  detectByOnnx: vi.fn(),
  detectByTesseract: vi.fn(),
  detectByHeuristic: vi.fn(),
}));

vi.mock('../../../src/pipeline/detect/onnxDetect', () => ({
  detectByOnnx: mocks.detectByOnnx,
}));

vi.mock('../../../src/pipeline/detect/heuristicDetect', () => ({
  detectByTesseract: mocks.detectByTesseract,
  detectByHeuristic: mocks.detectByHeuristic,
}));

import { detectTextRegionsWithMask } from '../../../src/pipeline/detect';

const image = {} as PipelineImage;
const platform = {} as PlatformProvider;
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
    mocks.detectByTesseract.mockReset();
    mocks.detectByHeuristic.mockReset();
  });

  it('reports ONNX when the model succeeds', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockResolvedValue({
      regions: [region],
      rawMaskCanvas: null,
      actualProvider: 'wasm',
      providerReports: [report],
    });

    await expect(detectTextRegionsWithMask(image, platform)).resolves.toMatchObject({
      engine: 'onnx',
      actualProvider: 'wasm',
      providerReports: [report],
    });
    expect(mocks.detectByTesseract).not.toHaveBeenCalled();
  });

  it('reports Tesseract and preserves the unsatisfied ONNX provider report', async () => {
    const report = providerReport(false);
    mocks.detectByOnnx.mockRejectedValue(new ProviderExecutionError(
      {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
      },
      report,
    ));
    mocks.detectByTesseract.mockResolvedValue([region]);

    await expect(detectTextRegionsWithMask(image, platform)).resolves.toMatchObject({
      engine: 'tesseract',
      fallbackReason: 'onnx: pipeline.failure.providerExecution',
      providerReports: [report],
    });
  });

  it('preserves a satisfied provider report when ONNX post-processing falls back', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockRejectedValue(Object.assign(
      new Error('invalid detector output'),
      { providerReports: [report] },
    ));
    mocks.detectByTesseract.mockResolvedValue([region]);

    await expect(detectTextRegionsWithMask(image, platform)).resolves.toMatchObject({
      engine: 'tesseract',
      fallbackReason: 'onnx: invalid detector output',
      providerReports: [report],
    });
  });

  it('reports heuristic and both upstream fallback reasons', async () => {
    mocks.detectByOnnx.mockRejectedValue(new Error('worker unavailable'));
    mocks.detectByTesseract.mockRejectedValue(new Error('tesseract unavailable'));
    mocks.detectByHeuristic.mockResolvedValue([region]);

    const result = await detectTextRegionsWithMask(image, platform);
    expect(result.engine).toBe('heuristic');
    expect(result.fallbackReason).toContain('onnx: worker unavailable');
    expect(result.fallbackReason).toContain('tesseract: tesseract unavailable');
    expect(result.providerReports).toEqual([]);
  });

  it('keeps the strict no-text result instead of silently changing engines', async () => {
    const report = providerReport(true);
    mocks.detectByOnnx.mockResolvedValue({
      regions: [],
      rawMaskCanvas: null,
      providerReports: [report],
    });

    const error = await detectTextRegionsWithMask(image, platform).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      message: '未找到文本',
      providerReports: [report],
    });
    expect(mocks.detectByTesseract).not.toHaveBeenCalled();
  });
});
