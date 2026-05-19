import type { OcrProvider, OcrRecognizeOutput } from './provider';
import type { TextRegion } from '../../types';
import { runOcrByOnnxInternal } from './index';

export const builtinOcrProvider: OcrProvider = {
  name: 'builtin',
  async recognize(image: HTMLImageElement, regions: TextRegion[]): Promise<OcrRecognizeOutput> {
    const internal = await runOcrByOnnxInternal(image, regions);
    return { results: internal.results, provider: internal.provider, webnnDeviceType: internal.webnnDeviceType };
  },
};
