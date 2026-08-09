import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeGigaViewerTtbFiles,
  splitGigaViewerTtbBlob,
} from '../../../apps/extension/src/content/readerEngines/gigaViewerTtbImages';

function canvasDocument(draws: Array<unknown[]>): Document {
  return {
    createElement: (name: string) => {
      if (name !== 'canvas') throw new Error(`unexpected element: ${name}`);
      const context = {
        drawImage: (...args: unknown[]) => draws.push(args),
      };
      return {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(new Blob(['png'], { type: 'image/png' }));
        },
      } as unknown as HTMLCanvasElement;
    },
  } as unknown as Document;
}

describe('GigaViewer TTB image composition', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stacks five equal-width source slices without gaps', async () => {
    const close = vi.fn();
    const bitmaps = [
      { width: 720, height: 703, close },
      { width: 720, height: 703, close },
      { width: 720, height: 703, close },
      { width: 720, height: 703, close },
      { width: 720, height: 703, close },
    ];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmaps.shift()!));
    const draws: Array<unknown[]> = [];

    const file = await composeGigaViewerTtbFiles(
      [0, 1, 2, 3, 4].map((index) => new File([String(index)], `${index}.png`)),
      new AbortController().signal,
      canvasDocument(draws),
    );

    expect(file.name).toBe('giga-viewer-ttb-logical-page.png');
    expect(draws.map((draw) => draw.slice(1))).toEqual([
      [0, 0],
      [0, 703],
      [0, 1406],
      [0, 2109],
      [0, 2812],
    ]);
    expect(close).toHaveBeenCalledTimes(5);
  });

  it('crops a translated logical page back at exact member heights', async () => {
    const close = vi.fn();
    const bitmap = { width: 720, height: 3515, close };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const draws: Array<unknown[]> = [];

    const slices = await splitGigaViewerTtbBlob(
      new Blob(['translated'], { type: 'image/png' }),
      [703, 703, 703, 703, 703],
      new AbortController().signal,
      canvasDocument(draws),
    );

    expect(slices).toHaveLength(5);
    expect(draws.map((draw) => draw.slice(1))).toEqual([
      [0, 0, 720, 703, 0, 0, 720, 703],
      [0, 703, 720, 703, 0, 0, 720, 703],
      [0, 1406, 720, 703, 0, 0, 720, 703],
      [0, 2109, 720, 703, 0, 0, 720, 703],
      [0, 2812, 720, 703, 0, 0, 720, 703],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
});
