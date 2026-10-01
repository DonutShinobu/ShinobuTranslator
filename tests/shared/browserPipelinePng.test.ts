import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineCanvas } from '@shinobu/image-pipeline';
import { browserPipelinePlatform } from '../../apps/extension/src/shared/browserPipelinePlatform';

describe('browser PNG encoding candidate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps synchronous export when disabled or OffscreenCanvas is unavailable', async () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,AAH/');
    const canvas = { width: 3, height: 1, toDataURL } as unknown as PipelineCanvas;
    const baseline = browserPipelinePlatform.encodeCanvasToPng!(canvas);
    expect(baseline).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (baseline as Blob).arrayBuffer())).toEqual(Uint8Array.of(0, 1, 255));
    vi.stubGlobal('__shinobuColdStartOffscreenPng', true);
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(browserPipelinePlatform.encodeCanvasToPng!(canvas)).toBeInstanceOf(Blob);
    expect(toDataURL).toHaveBeenCalledTimes(2);
  });

  it('waits for completed PNG bytes before releasing the same-size surface', async () => {
    vi.stubGlobal('__shinobuColdStartOffscreenPng', true);
    let resolve!: (value: Blob) => void;
    const png = new Promise<Blob>((done) => { resolve = done; });
    const context = { globalCompositeOperation: 'source-over', drawImage: vi.fn() };
    const convert = vi.fn(() => png);
    const surfaces: Array<{ width: number; height: number }> = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) { surfaces.push(this); }
      getContext = () => context;
      convertToBlob = convert;
    });
    const canvas = { width: 2921, height: 4096, toDataURL: vi.fn() } as unknown as PipelineCanvas;
    const encoded = browserPipelinePlatform.encodeCanvasToPng!(canvas);
    expect(surfaces[0]).toMatchObject({ width: canvas.width, height: canvas.height });
    expect(context.drawImage).toHaveBeenCalledWith(canvas, 0, 0);
    expect(context.globalCompositeOperation).toBe('copy');
    expect(convert).toHaveBeenCalledWith({ type: 'image/png' });
    expect(canvas.toDataURL).not.toHaveBeenCalled();
    const result = new Blob([Uint8Array.of(0, 128, 255)], { type: 'image/png' });
    resolve(result);
    expect(await encoded).toBe(result);
    expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    expect(canvas.width).toBe(2921);
    expect(canvas.height).toBe(4096);
  });
});
