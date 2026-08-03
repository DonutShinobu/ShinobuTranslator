import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineImage, PlatformProvider } from '../../../src/runtime/platform';
import type { TextRegion } from '../../../src/types';

vi.mock('../../../src/pipeline/detect/onnxDetect', () => ({
  detectByOnnx: vi.fn(),
}));
vi.mock('../../../src/pipeline/detect/heuristicOnly', () => ({
  detectByHeuristic: vi.fn(),
}));

import { detectTextRegionsWithMask } from '../../../src/pipeline/detect/extensionDetect';
import { detectByHeuristic } from '../../../src/pipeline/detect/heuristicOnly';
import { detectByOnnx } from '../../../src/pipeline/detect/onnxDetect';

const region: TextRegion = {
  id: 'region-1',
  box: { x: 1, y: 2, width: 3, height: 4 },
  sourceText: '',
  translatedText: '',
};
const image = {} as PipelineImage;
const platform = {} as PlatformProvider;

describe('extension detector composition', () => {
  beforeEach(() => {
    vi.mocked(detectByOnnx).mockReset();
    vi.mocked(detectByHeuristic).mockReset();
  });

  it('uses ONNX when it finds text', async () => {
    vi.mocked(detectByOnnx).mockResolvedValue({
      regions: [region],
      rawMaskCanvas: null,
      engine: 'onnx',
    });

    await expect(detectTextRegionsWithMask(image, platform)).resolves.toMatchObject({
      regions: [region],
      engine: 'onnx',
    });
    expect(detectByHeuristic).not.toHaveBeenCalled();
  });

  it('falls back directly from ONNX failure to the local heuristic', async () => {
    vi.mocked(detectByOnnx).mockRejectedValue(new Error('WASM unavailable'));
    vi.mocked(detectByHeuristic).mockResolvedValue([region]);

    await expect(detectTextRegionsWithMask(image, platform)).resolves.toMatchObject({
      regions: [region],
      rawMaskCanvas: null,
      engine: 'heuristic',
      fallbackReason: 'onnx: WASM unavailable',
    });
  });

  it('reports no text when both local detectors fail', async () => {
    vi.mocked(detectByOnnx).mockRejectedValue(new Error('model failed'));
    vi.mocked(detectByHeuristic).mockResolvedValue([]);

    await expect(detectTextRegionsWithMask(image, platform)).rejects.toThrow('未找到文本');
  });
});
