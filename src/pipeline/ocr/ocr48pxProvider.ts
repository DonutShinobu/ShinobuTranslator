import type { OcrProvider, OcrRecognizeOutput } from './provider';
import type { TextRegion } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import { runOcrByOnnxInternal } from './index';

export const ocr48pxProvider: OcrProvider = {
  name: '48px',
  async recognize(image: PipelineImage, regions: TextRegion[], platform?: PlatformProvider): Promise<OcrRecognizeOutput> {
    const internal = await runOcrByOnnxInternal(image, regions, platform!);
    return { results: internal.results, provider: internal.provider, webnnDeviceType: internal.webnnDeviceType };
  },
};
