import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVisibleTab } from '../../apps/extension/src/background/images/imageService';

describe('captureVisibleTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses to capture when the requesting content tab is no longer active', async () => {
    const capture = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {},
      tabs: {
        query: (_query: unknown, callback: (tabs: Array<{ id: number }>) => void) => {
          callback([{ id: 8 }]);
        },
        captureVisibleTab: capture,
      },
    });

    await expect(captureVisibleTab({
      tab: { id: 7, windowId: 2, url: 'https://reader.example/' },
    })).rejects.toThrow('截图请求所属标签页已不再活动');
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures exactly the active sender tab window', async () => {
    vi.stubGlobal('chrome', {
      runtime: {},
      tabs: {
        query: (_query: unknown, callback: (tabs: Array<{ id: number }>) => void) => {
          callback([{ id: 7 }]);
        },
        captureVisibleTab: (
          _windowId: number,
          _options: unknown,
          callback: (dataUrl: string) => void,
        ) => callback('data:image/png;base64,aW1hZ2U='),
      },
    });

    await expect(captureVisibleTab({
      tab: { id: 7, windowId: 2, url: 'https://reader.example/' },
    })).resolves.toEqual({
      base64: 'aW1hZ2U=',
      contentType: 'image/png',
      sourceUrl: 'https://reader.example/',
    });
  });
});
