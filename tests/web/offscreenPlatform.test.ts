import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOffscreenPlatform } from '../../apps/web/src/runtime/offscreenPlatform';

class LoadedFontFace {
  constructor(
    readonly family: string,
    readonly source: ArrayBuffer,
    readonly descriptors?: FontFaceDescriptors,
  ) {}

  async load(): Promise<LoadedFontFace> {
    return this;
  }
}

describe('Web Worker offscreen platform fonts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('continues after registered font faces load even when FontFaceSet.ready never settles', async () => {
    vi.useFakeTimers();

    const add = vi.fn();
    const neverReady = new Promise<FontFaceSet>(() => {});
    vi.stubGlobal('fonts', { add, ready: neverReady });
    vi.stubGlobal('FontFace', LoadedFontFace);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    })));

    const platform = createOffscreenPlatform();
    platform.registerFont('/fonts/test.woff2', 'MTX-Test', {
      style: 'normal',
      weight: '200 900',
    });

    const outcome = Promise.race([
      platform.waitForFonts().then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => resolve('timed-out'), 1_000);
      }),
    ]);

    await vi.runAllTimersAsync();

    expect(await outcome).toBe('resolved');
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      family: 'MTX-Test',
      descriptors: {
        style: 'normal',
        weight: '200 900',
      },
    });
  });
});
