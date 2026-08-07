import { describe, expect, it, vi } from 'vitest';
import { PageProjectionController } from '../../../../apps/extension/src/content/core/continuous/pageProjectionController';
import type { ReaderPageSurface } from '../../../../apps/extension/src/content/core/continuous/contracts';
import type { PageArtifactPort } from '../../../../apps/extension/src/content/core/continuous/pageArtifactPort';

describe('PageProjectionController', () => {
  it('mounts only a matching revision and revokes the object URL when hidden', async () => {
    const appendChild = vi.fn();
    const surface: ReaderPageSurface = {
      identity: { engineId: 'fake', contextKey: 'chapter', pageIndex: 2 },
      slot: {} as HTMLElement,
      source: { kind: 'viewport-region' },
      viewportRect: { left: 20, top: 30, width: 100, height: 150 },
      projectionAnchor: {
        appendChild,
        getBoundingClientRect: () => ({ left: 10, top: 20 }),
      } as unknown as HTMLElement,
    };
    const artifact = {
      id: 'result-1',
      tabId: 1,
      contentSessionId: 'session-1',
      kind: 'translated-result' as const,
      name: 'translated.png',
      type: 'image/png',
      size: 10,
    };
    const read = vi.fn(async () => new File(['translated'], 'translated.png', {
      type: 'image/png',
    }));
    const artifacts = { read } as unknown as PageArtifactPort;
    const remove = vi.fn();
    const image = {
      dataset: {},
      style: {},
      remove,
    } as unknown as HTMLImageElement;
    const revokeObjectURL = vi.fn();
    const controller = new PageProjectionController(artifacts, {
      createImage: () => image,
      urlApi: {
        createObjectURL: () => 'blob:translated',
        revokeObjectURL,
      },
      createResizeObserver: () => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as ResizeObserver),
    });
    const results = [{ identity: surface.identity, fingerprint: 'aaaaaaaaaaaaaaaa', artifact }];

    await controller.sync(
      { pages: [surface] },
      results,
      new Map([['fake:chapter:2', 'bbbbbbbbbbbbbbbb']]),
    );
    expect(read).not.toHaveBeenCalled();

    await controller.sync(
      { pages: [surface] },
      results,
      new Map([['fake:chapter:2', 'aaaaaaaaaaaaaaaa']]),
    );
    expect(appendChild).toHaveBeenCalledWith(image);
    expect(image.dataset.mtContinuousProjection).toBe('');
    expect(image.style.left).toBe('10px');
    expect(image.style.top).toBe('10px');

    controller.setDisplayMode('original');
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:translated');
  });
});
