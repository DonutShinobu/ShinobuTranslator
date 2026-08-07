import { describe, expect, it, vi } from 'vitest';
import { PageSourceResolver } from '../../../../apps/extension/src/content/core/continuous/pageSourceResolver';
import type { ReaderPageSurface } from '../../../../apps/extension/src/content/core/continuous/contracts';

function surface(pageIndex: number, toBlob: HTMLCanvasElement['toBlob']): ReaderPageSurface {
  return {
    identity: { engineId: 'fake', contextKey: 'chapter', pageIndex },
    slot: { isConnected: true } as HTMLElement,
    source: {
      kind: 'canvas',
      element: {
        isConnected: true,
        width: 800,
        height: 1200,
        toBlob,
      } as HTMLCanvasElement,
    },
    viewportRect: { left: pageIndex * 100, top: 0, width: 100, height: 150 },
    projectionAnchor: {} as HTMLElement,
  };
}

describe('PageSourceResolver', () => {
  it('uses exportable canvas snapshots without invoking tab capture', async () => {
    const capture = vi.fn();
    const pages = [0, 1].map((pageIndex) => surface(pageIndex, (callback) => {
      callback(new Blob([`canvas-${pageIndex}`], { type: 'image/png' }));
    }));
    const resolver = new PageSourceResolver({
      capture: { capture },
      crop: vi.fn(),
      hideExtensionUi: () => () => undefined,
      waitForNextPaint: async () => undefined,
      isDocumentVisible: () => true,
    });

    const resolved = await resolver.resolve(pages);

    expect(capture).not.toHaveBeenCalled();
    expect(await Promise.all(resolved.map(({ file }) => file.text()))).toEqual([
      'canvas-0',
      'canvas-1',
    ]);
  });

  it('captures the tab once and crops every page when any canvas cannot export', async () => {
    const restore = vi.fn();
    const capture = vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
      viewport: { width: 1200, height: 800 },
    }));
    const crop = vi.fn(async (_dataUrl, rect: { left: number }) => (
      new File([`crop-${rect.left}`], 'crop.png', { type: 'image/png' })
    ));
    const pages = [
      surface(0, (callback) => callback(new Blob(['canvas-0'], { type: 'image/png' }))),
      surface(1, (callback) => callback(null)),
    ];
    const resolver = new PageSourceResolver({
      capture: { capture },
      crop,
      hideExtensionUi: () => restore,
      waitForNextPaint: async () => undefined,
      isDocumentVisible: () => true,
    });

    const resolved = await resolver.resolve(pages);

    expect(capture).toHaveBeenCalledOnce();
    expect(crop).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledOnce();
    expect(await Promise.all(resolved.map(({ file }) => file.text()))).toEqual([
      'crop-0',
      'crop-100',
    ]);
  });
});
