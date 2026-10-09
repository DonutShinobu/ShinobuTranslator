import { expect, it, vi } from 'vitest';
import { describeVisionRegions } from '../../packages/image-pipeline/src/pipeline/visionRegionFilter';
import type { PipelineCanvas, PlatformProvider } from '../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../packages/image-pipeline/src/types';

it('crops padded detection blocks and preserves OCR metadata', () => {
  const drawImage = vi.fn();
  const crop = {
    width: 0, height: 0,
    getContext: () => ({ drawImage }),
    toDataURL: () => 'data:image/jpeg;base64,YQ==',
    dispose: vi.fn(),
  } as unknown as PipelineCanvas;
  const platform = { createCanvas: vi.fn((width: number, height: number) => {
    crop.width = width;
    crop.height = height;
    return crop;
  }) } as unknown as PlatformProvider;
  const original = { width: 100, height: 100 } as PipelineCanvas;
  const detected: TextRegion[] = [
    { id: 'raw', box: { x: 10, y: 20, width: 30, height: 40 }, prob: 0.7, sourceText: '', translatedText: '' },
  ];
  const merged = [{ ...detected[0], id: 'ocr', prob: 0.6, sourceText: 'あ' }];

  expect(describeVisionRegions(merged, detected, original, platform)).toEqual([expect.objectContaining({
    id: 'ocr', text: 'あ', ocrConfidence: 0.6, detectorConfidence: 0.7,
    areaPercent: 12, boxPercent: { x: 10, y: 20, width: 30, height: 40 },
    imageDataUrl: 'data:image/jpeg;base64,YQ==',
  })]);
  expect(platform.createCanvas).toHaveBeenCalledWith(38, 48);
  expect(drawImage).toHaveBeenCalledWith(original, 6, 16, 38, 48, 0, 0, 38, 48);
  expect(crop.dispose).toHaveBeenCalledOnce();
});

it('clamps crops to the source, caps their size, and disposes them when encoding fails', () => {
  const drawImage = vi.fn();
  const dispose = vi.fn();
  const crop = { width: 1024, height: 512, getContext: () => ({ drawImage }),
    toDataURL: () => { throw new Error('encoding failed'); }, dispose } as unknown as PipelineCanvas;
  const platform = { createCanvas: vi.fn(() => crop) } as unknown as PlatformProvider;
  const original = { width: 2000, height: 1000 } as PipelineCanvas;
  const region = { id: 'large', box: { x: 0, y: 0, width: 2000, height: 1000 }, sourceText: 'あ', translatedText: '' };
  expect(() => describeVisionRegions([region], [], original, platform)).toThrow('encoding failed');
  expect(platform.createCanvas).toHaveBeenCalledWith(1024, 512);
  expect(drawImage).toHaveBeenCalledWith(original, 0, 0, 2000, 1000, 0, 0, 1024, 512);
  expect(dispose).toHaveBeenCalledOnce();
});
