import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineImage, PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import type { ModelRuntime } from '@shinobu/model-runtime';

vi.mock('../../../packages/image-pipeline/src/pipeline/detect/onnxDetect', () => ({
  detectByOnnx: vi.fn(),
}));
vi.mock('../../../packages/image-pipeline/src/pipeline/detect/heuristicDetect', () => ({
  detectByTesseract: vi.fn(),
}));
vi.mock('../../../packages/image-pipeline/src/pipeline/detect/heuristicOnly', () => ({
  detectByHeuristic: vi.fn(),
}));

import { detectTextRegionsWithMask } from '../../../packages/image-pipeline/src/pipeline/detect';
import { detectByTesseract } from '../../../packages/image-pipeline/src/pipeline/detect/heuristicDetect';
import { detectByHeuristic } from '../../../packages/image-pipeline/src/pipeline/detect/heuristicOnly';
import { detectByOnnx } from '../../../packages/image-pipeline/src/pipeline/detect/onnxDetect';

const region: TextRegion = {
  id: 'region-1',
  box: { x: 1, y: 2, width: 3, height: 4 },
  sourceText: '',
  translatedText: '',
};
const image = {} as PipelineImage;
const platform = {} as PlatformProvider;
const modelRuntime = {} as ModelRuntime;

describe('extension detector composition', () => {
  beforeEach(() => {
    vi.mocked(detectByOnnx).mockReset();
    vi.mocked(detectByHeuristic).mockReset();
    vi.mocked(detectByTesseract).mockReset();
  });

  it('uses ONNX when it finds text', async () => {
    vi.mocked(detectByOnnx).mockResolvedValue({
      regions: [region],
      rawMaskCanvas: null,
      engine: 'onnx',
    });

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, { kind: 'heuristic-only' })).resolves.toMatchObject({
      regions: [region],
      engine: 'onnx',
    });
    expect(detectByHeuristic).not.toHaveBeenCalled();
    expect(detectByTesseract).not.toHaveBeenCalled();
  });

  it('falls back directly from ONNX failure to the local heuristic', async () => {
    vi.mocked(detectByOnnx).mockRejectedValue(new Error('WASM unavailable'));
    vi.mocked(detectByHeuristic).mockResolvedValue([region]);

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, { kind: 'heuristic-only' })).resolves.toMatchObject({
      regions: [region],
      rawMaskCanvas: null,
      engine: 'heuristic',
      fallbackReason: 'onnx: WASM unavailable',
    });
  });

  it('returns no text when ONNX fails and the local heuristic finds no regions', async () => {
    vi.mocked(detectByOnnx).mockRejectedValue(new Error('model failed'));
    vi.mocked(detectByHeuristic).mockResolvedValue([]);

    await expect(detectTextRegionsWithMask(image, platform, modelRuntime, { kind: 'heuristic-only' })).resolves.toMatchObject({
      regions: [],
      rawMaskCanvas: null,
      engine: 'heuristic',
      fallbackReason: 'onnx: model failed',
    });
  });
});
