import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineCanvas } from '@shinobu/image-pipeline';
import { encodeWorkerPng, type WorkerPngOutput } from '../../apps/extension/src/shared/pngEncodeWorker';
import { encodeCanvasToPngInWorker } from '../../apps/extension/src/shared/pngWorkerEncoder';

describe('PNG Worker candidate', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeWorkers() {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent<WorkerPngOutput>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor(public url: URL, public options: WorkerOptions) { workers.push(this); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    return workers;
  }

  it('transfers the full bitmap, waits for PNG, and terminates the short Worker', async () => {
    const workers = fakeWorkers();
    const bitmap = { width: 2921, height: 4096, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const canvas = { width: 2921, height: 4096, getContext: () => ({}) } as unknown as PipelineCanvas;
    const result = encodeCanvasToPngInWorker(canvas);
    await Promise.resolve();
    expect(workers[0].url.pathname).toMatch(/pngEncodeWorker\.ts$/);
    expect(workers[0].options).toEqual({ type: 'module' });
    expect(workers[0].postMessage).toHaveBeenCalledWith({ kind: 'image-bitmap', bitmap, profile: false, colorSpace: 'srgb' }, [bitmap]);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    const png = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' });
    workers[0].onmessage!({ data: { blob: png } } as MessageEvent<WorkerPngOutput>);
    expect(await result).toBe(png);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 2921, height: 4096 });
  });

  it('transfers the owned ImageData buffer without cloning RGBA in the comparison path', async () => {
    const workers = fakeWorkers();
    vi.stubGlobal('__shinobuColdStartWorkerPngRgba', true);
    const pixels = Uint8ClampedArray.of(1, 2, 3, 4, 231, 232, 233, 255);
    const getImageData = vi.fn(() => ({ data: pixels }));
    const canvas = { width: 2, height: 1, getContext: () => ({ getImageData }) } as unknown as PipelineCanvas;
    const result = encodeCanvasToPngInWorker(canvas);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect(workers[0].postMessage).toHaveBeenCalledWith({ kind: 'rgba', pixels, width: 2, height: 1, profile: false, colorSpace: 'srgb' }, [pixels.buffer]);
    const png = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' });
    workers[0].onmessage!({ data: { blob: png } } as MessageEvent<WorkerPngOutput>);
    expect(await result).toBe(png);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('closes a late bitmap snapshot after a Worker load failure', async () => {
    const workers = fakeWorkers();
    let resolve!: (value: ImageBitmap) => void;
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((done) => { resolve = done; }));
    const result = encodeCanvasToPngInWorker({ width: 3, height: 1, getContext: () => ({}) } as unknown as PipelineCanvas);
    workers[0].onerror!({ message: 'blocked Worker' } as ErrorEvent);
    await expect(result).rejects.toThrow('blocked Worker');
    const bitmap = { width: 3, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    resolve(bitmap);
    await Promise.resolve();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(workers[0].postMessage).not.toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('encodes at the source size and releases worker pixels only after PNG completion', async () => {
    let resolve!: (value: Blob) => void;
    const converted = new Promise<Blob>((done) => { resolve = done; });
    const convertToBlob = vi.fn(() => converted);
    const context = { globalCompositeOperation: 'source-over', drawImage: vi.fn() };
    const surfaces: Array<{ width: number; height: number }> = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) { surfaces.push(this); }
      getContext = () => context;
      convertToBlob = convertToBlob;
    });
    const bitmap = { width: 257, height: 131, close: vi.fn() } as unknown as ImageBitmap;
    const result = encodeWorkerPng({ kind: 'image-bitmap', bitmap, profile: false, colorSpace: 'srgb' });
    expect(surfaces[0]).toMatchObject({ width: 257, height: 131 });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(context.globalCompositeOperation).toBe('copy');
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
    expect(bitmap.close).not.toHaveBeenCalled();
    const png = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' });
    resolve(png);
    expect((await result).blob).toBe(png);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
  });
});
