import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformProvider, PipelineImage } from '../../../packages/image-pipeline/src/runtime/platform';
import type { ModelRuntime } from '@shinobu/model-runtime';

const mocks = vi.hoisted(() => ({
  detectByOnnx: vi.fn(),
  detectByTesseract: vi.fn(),
  detectByHeuristic: vi.fn(),
}));

vi.mock('../../../packages/image-pipeline/src/pipeline/detect/onnxDetect', () => ({
  detectByOnnx: mocks.detectByOnnx,
}));

vi.mock('../../../packages/image-pipeline/src/pipeline/detect/heuristicDetect', () => ({
  detectByTesseract: mocks.detectByTesseract,
}));

vi.mock('../../../packages/image-pipeline/src/pipeline/detect/heuristicOnly', () => ({
  detectByHeuristic: mocks.detectByHeuristic,
}));

import { detectTextRegionsWithMask } from '../../../packages/image-pipeline/src/pipeline/detect';

const image = {} as PipelineImage;
const platform = {} as PlatformProvider;
const modelRuntime = {} as ModelRuntime;
const region = {
  id: 'region-1',
  box: { x: 0, y: 0, width: 10, height: 20 },
  sourceText: '',
  translatedText: '',
};

describe('detectTextRegionsWithMask engine reporting', () => {
  beforeEach(() => {
    mocks.detectByOnnx.mockReset();
    mocks.detectByTesseract.mockReset();
    mocks.detectByHeuristic.mockReset();
  });

  it('reports ONNX when the model succeeds', async () => {
    mocks.detectByOnnx.mockResolvedValue({ regions: [region], rawMaskCanvas: null, actualProvider: 'wasm' });

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, {
      kind: 'tesseract-then-heuristic',
      detectWithTesseract: mocks.detectByTesseract,
    })).resolves.toMatchObject({
      engine: 'onnx',
      actualProvider: 'wasm',
    });
    expect(mocks.detectByTesseract).not.toHaveBeenCalled();
  });

  it('reports Tesseract and the ONNX fallback reason', async () => {
    mocks.detectByOnnx.mockRejectedValue(new Error('worker unavailable'));
    mocks.detectByTesseract.mockResolvedValue([region]);

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, {
      kind: 'tesseract-then-heuristic',
      detectWithTesseract: mocks.detectByTesseract,
    })).resolves.toMatchObject({
      engine: 'tesseract',
      fallbackReason: 'onnx: worker unavailable',
    });
  });

  it('reports heuristic and both upstream fallback reasons', async () => {
    mocks.detectByOnnx.mockRejectedValue(new Error('worker unavailable'));
    mocks.detectByTesseract.mockRejectedValue(new Error('tesseract unavailable'));
    mocks.detectByHeuristic.mockResolvedValue([region]);

    const result = await detectTextRegionsWithMask(image, platform, modelRuntime, {
      kind: 'tesseract-then-heuristic',
      detectWithTesseract: mocks.detectByTesseract,
    });
    expect(result.engine).toBe('heuristic');
    expect(result.fallbackReason).toContain('onnx: worker unavailable');
    expect(result.fallbackReason).toContain('tesseract: tesseract unavailable');
  });

  it('keeps the strict no-text result instead of silently changing engines', async () => {
    mocks.detectByOnnx.mockResolvedValue({ regions: [], rawMaskCanvas: null });

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, {
      kind: 'tesseract-then-heuristic',
      detectWithTesseract: mocks.detectByTesseract,
    })).rejects.toThrow('未找到文本');
    expect(mocks.detectByTesseract).not.toHaveBeenCalled();
  });
});
