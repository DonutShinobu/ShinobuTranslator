import { describe, expect, it, vi } from 'vitest';
import { prepareReadingPanels, sortRegionsForRender } from '../../packages/image-pipeline/src/pipeline/readingOrder';
import type { PipelineCanvas, PlatformProvider } from '../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../packages/image-pipeline/src/types';

function fixture(throws = false) {
  const width = 300, height = 400;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 10; y < 390; y += 1) {
    if (y >= 185 && y < 215) continue;
    for (let x = 10; x < 290; x += 1) {
      const p = (y * width + x) * 4;
      pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
    }
  }
  const source = { width, height } as PipelineCanvas;
  const read = vi.fn(() => {
    if (throws) throw new Error('canvas read failed');
    return { width, height, data: pixels.slice() };
  });
  const platform = { createCanvas: () => ({ width, height, getContext: () => ({
    drawImage: vi.fn(), getImageData: read,
  }) }) } as unknown as PlatformProvider;
  const region = (id: string, x: number, y: number): TextRegion => ({
    id, box: { x, y, width: 30, height: 50 }, direction: 'v', sourceText: id, translatedText: '',
  });
  const regions = [region('bottom-left', 30, 240), region('top-left', 30, 40),
    region('bottom-right', 230, 240), region('top-right', 230, 40)];
  return { source, platform, read, pixels, regions };
}

describe('prepared reading panels', () => {
  it('uses the same panels/order and never reads the source twice', () => {
    const { source, platform, read, pixels, regions } = fixture();
    const snapshot = pixels.slice();
    const baseline = sortRegionsForRender(regions, source, platform);
    const panels = prepareReadingPanels(source, platform);
    expect(panels?.length).toBeGreaterThan(0);
    const beforeSort = read.mock.calls.length;
    const candidate = sortRegionsForRender(regions, source, platform, panels);
    expect(candidate).toEqual(baseline);
    expect(candidate.map(region => region.id)).toEqual(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
    expect(read.mock.calls).toHaveLength(beforeSort);
    expect(pixels).toEqual(snapshot);
  });

  it('caches an image failure as the same simple-sort fallback without retrying', () => {
    const { source, platform, read, regions } = fixture(true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const baseline = sortRegionsForRender(regions, source, platform);
      const panels = prepareReadingPanels(source, platform);
      expect(panels).toBeNull();
      const beforeSort = read.mock.calls.length;
      expect(sortRegionsForRender(regions, source, platform, panels)).toEqual(baseline);
      expect(read.mock.calls).toHaveLength(beforeSort);
    } finally {
      warning.mockRestore();
    }
  });

  it('retains the zero/one-region early return for every preparation state', () => {
    const { source, platform, read, regions } = fixture();
    for (const panels of [undefined, null, [], [{ x: 0, y: 0, width: 300, height: 400 }]]) {
      expect(sortRegionsForRender([], source, platform, panels)).toEqual([]);
      expect(sortRegionsForRender([regions[0]], source, platform, panels)).toEqual([regions[0]]);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
