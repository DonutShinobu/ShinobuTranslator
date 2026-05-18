import type { OcrProvider, OcrRecognizeResult } from './provider';
import type { TextRegion } from '../../types';
import { runOcrByOnnxInternal } from './index';

export const builtinOcrProvider: OcrProvider = {
  name: 'builtin',
  async recognize(image: HTMLImageElement, regions: TextRegion[]): Promise<OcrRecognizeResult[]> {
    const internal = await runOcrByOnnxInternal(image, regions);
    return internal.results;
  },
};