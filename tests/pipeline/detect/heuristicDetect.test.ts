import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PipelineRenderingContext,
  PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  PSM: {
    SPARSE_TEXT: '11',
  },
  createWorker: mocks.createWorker,
}));

import { detectByTesseract } from '../../../packages/image-pipeline/src/pipeline/detect/heuristicDetect';

describe('Tesseract detector input', () => {
  beforeEach(() => {
    mocks.createWorker.mockReset();
  });

  it('encodes a Worker canvas as a Blob before recognition', async () => {
    const recognize = vi.fn(async (input: unknown) => {
      if (!(input instanceof Blob)) {
        throw new Error('Error attempting to read image.');
      }
      return {
        data: {
          lines: [],
          words: [],
        },
      };
    });
    mocks.createWorker.mockResolvedValue({
      setParameters: vi.fn(),
      recognize,
      terminate: vi.fn(),
    });

    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
      putImageData: vi.fn(),
    } as unknown as PipelineRenderingContext;
    const encoded = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: 'image/png',
    });
    const canvas = {
      width: 2,
      height: 2,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(),
      convertToBlob: vi.fn(async () => encoded),
    } satisfies PipelineCanvas;
    const platform = {
      createCanvas: vi.fn(() => canvas),
    } as unknown as PlatformProvider;
    const image = {
      naturalWidth: 2,
      naturalHeight: 2,
    } as PipelineImage;

    await expect(detectByTesseract(image, platform)).resolves.toEqual([]);

    expect(recognize).toHaveBeenCalledWith(encoded);
  });
});
