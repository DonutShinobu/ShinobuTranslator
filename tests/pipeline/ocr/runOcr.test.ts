import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@shinobu/model-runtime';
import type {
  PipelineImage,
  PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import { runOcr } from '../../../packages/image-pipeline/src/pipeline/ocr';
import { registerOcrProvider } from '../../../packages/image-pipeline/src/pipeline/ocr/provider';

describe('runOcr', () => {
  it('returns a valid empty result when the provider rejects every candidate', async () => {
    registerOcrProvider({
      name: 'empty-result-fixture',
      recognize: vi.fn().mockResolvedValue({
        results: [],
        provider: 'webgpu',
      }),
    });
    const image = {
      src: 'fixture.png',
      naturalWidth: 100,
      naturalHeight: 200,
      onload: null,
      onerror: null,
    } as PipelineImage;
    const detectedRegions: TextRegion[] = [{
      id: 'region-1',
      box: { x: 10, y: 20, width: 30, height: 80 },
      direction: 'v',
      sourceText: '',
      translatedText: '',
    }];

    const result = await runOcr(
      image,
      detectedRegions,
      'empty-result-fixture',
      {} as PlatformProvider,
      undefined,
      {} as ModelRuntime,
    );

    expect(result).toMatchObject({
      regions: [],
      actualProvider: 'webgpu',
      debug: {
        candidateCount: 0,
        preparedCount: 0,
      },
    });
  });
});
