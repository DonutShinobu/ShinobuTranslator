import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserPipelinePlatform as browserPlatform } from '../../apps/extension/src/shared/browserPipelinePlatform';
import type { PipelineCanvas } from '../../packages/image-pipeline/src/runtime/platform';

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

describe('extension offscreen browser platform PNG export', () => {
  it('uses the synchronous canvas data URL path instead of async toBlob', async () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,cG5n');
    const toBlob = vi.fn();
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      toDataURL,
      toBlob,
    } satisfies PipelineCanvas;

    const blob = await browserPlatform.encodeCanvasToPng?.(canvas);

    expect(toDataURL).toHaveBeenCalledWith('image/png');
    expect(toBlob).not.toHaveBeenCalled();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('image/png');
    expect(await blob?.text()).toBe('png');
  });

  it('rejects a canvas export that did not produce PNG data', () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => null,
      toDataURL: () => 'data:,',
    } satisfies PipelineCanvas;

    expect(() => browserPlatform.encodeCanvasToPng?.(canvas)).toThrow(
      '导出译图失败',
    );
  });
});
