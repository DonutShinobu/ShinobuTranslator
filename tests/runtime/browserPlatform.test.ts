import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserPipelinePlatform as browserPlatform } from '../../src/shared/browserPipelinePlatform';

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

describe('extension offscreen browser platform fonts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, loads, and installs a registered variable font face', async () => {
    const add = vi.fn();
    vi.stubGlobal('document', {
      fonts: { add },
    });
    vi.stubGlobal('FontFace', LoadedFontFace);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    })));

    browserPlatform.registerFont(
      'chrome-extension://shinobu/fonts/test.woff2',
      'MTX-Test',
      { style: 'normal', weight: '200 900' },
    );
    await browserPlatform.waitForFonts();

    expect(fetch).toHaveBeenCalledWith(
      'chrome-extension://shinobu/fonts/test.woff2',
    );
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
