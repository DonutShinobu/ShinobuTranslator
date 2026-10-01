import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryNativeOpaqueMaskThreshold } from '../../packages/image-pipeline/src/pipeline/image';
import type { PipelineCanvas, PlatformProvider } from '../../packages/image-pipeline/src/runtime/platform';

const flags = globalThis as {
  __shinobuColdStartMaskNativeThreshold?: boolean;
  __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
};
afterEach(() => {
  delete flags.__shinobuColdStartMaskNativeThreshold;
  delete flags.__shinobuColdStartInitMark;
});

function fixture() {
  const sourceContext = {
    getContextAttributes: vi.fn(() => ({ colorSpace: 'srgb', colorType: 'unorm8' })),
    getImageData: vi.fn(() => { throw new Error('no source readback'); }),
    drawImage: vi.fn(),
  };
  const source = { width: 7, height: 3, getContext: vi.fn(() => sourceContext) };
  let saved: { filter: string; imageSmoothingEnabled: boolean; globalCompositeOperation: string };
  const context = {
    filter: 'none', imageSmoothingEnabled: true, globalCompositeOperation: 'source-over',
    getContextAttributes: vi.fn(() => ({ colorSpace: 'srgb', colorType: 'unorm8' })),
    drawImage: vi.fn(),
    save: vi.fn(() => { saved = {
      filter: context.filter, imageSmoothingEnabled: context.imageSmoothingEnabled,
      globalCompositeOperation: context.globalCompositeOperation,
    }; }),
    restore: vi.fn(() => { Object.assign(context, saved); }),
  };
  const target = { width: 7, height: 3, getContext: vi.fn(() => context), dispose: vi.fn() };
  const createCanvas = vi.fn(() => target);
  const platform = { createCanvas } as unknown as PlatformProvider;
  return { source: source as unknown as PipelineCanvas, sourceContext, context, target, createCanvas, platform };
}

describe('native opaque mask threshold lifecycle', () => {
  it('defaults off without querying or allocating canvases', () => {
    const f = fixture();
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBeNull();
    expect(f.source.getContext).not.toHaveBeenCalled();
    expect(f.createCanvas).not.toHaveBeenCalled();
  });

  it.each([
    { colorSpace: 'display-p3', colorType: 'unorm8' },
    { colorSpace: 'srgb', colorType: 'float16' },
    { colorSpace: '', colorType: '' },
  ])('keeps the CPU path for source attributes %j', (attrs) => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    const f = fixture();
    f.sourceContext.getContextAttributes.mockReturnValue(attrs);
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBeNull();
    expect(f.createCanvas).not.toHaveBeenCalled();
    expect(f.sourceContext.getImageData).not.toHaveBeenCalled();
  });

  it('draws one to one into a new CPU sRGB 8-bit canvas and restores state', () => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    const f = fixture();
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBe(f.target);
    expect(f.createCanvas).toHaveBeenCalledWith(7, 3);
    expect(f.target.getContext).toHaveBeenCalledWith('2d', {
      willReadFrequently: true, colorSpace: 'srgb', colorType: 'unorm8',
    });
    expect(f.context.drawImage).toHaveBeenCalledWith(f.source, 0, 0);
    expect(f.context).toMatchObject({ filter: 'none', imageSmoothingEnabled: true, globalCompositeOperation: 'source-over' });
    expect(f.target.dispose).not.toHaveBeenCalled();
    expect(f.source).toMatchObject({ width: 7, height: 3 });
    expect(f.sourceContext.drawImage).not.toHaveBeenCalled();
    expect(f.sourceContext.getImageData).not.toHaveBeenCalled();
  });

  it('releases a target that silently rejects filter assignment', () => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    const f = fixture();
    Object.defineProperty(f.context, 'filter', { configurable: true, get: () => 'none', set: () => undefined });
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBeNull();
    expect(f.context.drawImage).not.toHaveBeenCalled();
    expect(f.context.restore).toHaveBeenCalledOnce();
    expect(f.target.dispose).toHaveBeenCalledOnce();
    expect(f.target).toMatchObject({ width: 0, height: 0 });
    expect(f.source).toMatchObject({ width: 7, height: 3 });
  });

  it('releases a target with unknown or incompatible context attributes', () => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    const f = fixture();
    f.context.getContextAttributes.mockReturnValue({ colorSpace: 'srgb', colorType: 'float16' });
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBeNull();
    expect(f.context.drawImage).not.toHaveBeenCalled();
    expect(f.target.dispose).toHaveBeenCalledOnce();
  });

  it('restores state and retains source pixels when native draw throws', () => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    const f = fixture();
    f.context.drawImage.mockImplementation(() => { throw new Error('native draw failed'); });
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBeNull();
    expect(f.context.restore).toHaveBeenCalledOnce();
    expect(f.target.dispose).toHaveBeenCalledOnce();
    expect(f.sourceContext.getImageData).not.toHaveBeenCalled();
    expect(f.sourceContext.drawImage).not.toHaveBeenCalled();
  });

  it('ignores a throwing observer while retaining the successful canvas', () => {
    flags.__shinobuColdStartMaskNativeThreshold = true;
    flags.__shinobuColdStartInitMark = () => { throw new Error('observer failed'); };
    const f = fixture();
    expect(tryNativeOpaqueMaskThreshold(f.source, f.platform)).toBe(f.target);
    expect(f.target.dispose).not.toHaveBeenCalled();
  });
});
