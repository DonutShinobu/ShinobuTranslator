import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ReaderEngineAdapter,
  ReaderEngineReadingModeSession,
} from '../../../apps/extension/src/content/core/continuous/contracts';
import { ReaderEngineRegistry } from '../../../apps/extension/src/content/core/continuous/readerEngineRegistry';
import { ReaderEngineReadingModeModule } from '../../../apps/extension/src/content/core/reading/readerEngineReadingModeModule';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import type { ImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';

describe('ReaderEngineReadingModeModule', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rebinds a reused reader DOM when the adapter context identity changes', async () => {
    let mutationCallback: MutationCallback | undefined;
    const observe = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      observe = observe;
      disconnect = vi.fn();
      takeRecords = () => [];
    });

    const root = { isConnected: true } as HTMLElement;
    const sessionAnchor = { isConnected: true } as Element;
    let contextKey = 'giga-viewer:episode:one:digest-1:https://reader.example/episode/one';
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const createReadingModeSession = vi.fn((): ReaderEngineReadingModeSession => {
      const dispose = vi.fn();
      disposals.push(dispose);
      return {
        engineId: 'giga-viewer',
        contextKey,
        readVisibleSpread: () => ({ pages: [] }),
        observe: () => () => undefined,
        dispose,
        getReadingContextKey: () => contextKey,
        discoverReadingPages: async () => ({
          status: 'incomplete',
          reason: 'metadata-unavailable',
        }),
        getVisiblePages: () => [],
        createBottomBarAnchor: () => null,
        applyImageByKey: () => undefined,
      };
    });
    const adapter: ReaderEngineAdapter = {
      engineId: 'giga-viewer',
      detect: () => ({
        confidence: 'strong',
        root,
        sessionAnchor,
        contextKey,
        evidence: ['giga-viewer'],
      }),
      createSession: () => createReadingModeSession(),
      createReadingModeSession,
    };
    const document = { documentElement: {} } as Document;
    const window = {
      setTimeout: (callback: TimerHandler) => globalThis.setTimeout(callback, 0) as unknown as number,
      clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
    } as unknown as Window;
    const module = new ReaderEngineReadingModeModule({
      registry: new ReaderEngineRegistry([adapter]),
      stateStore: new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      executionArbiter: {} as ImageTranslationExecutionArbiter,
      document,
      window,
    });

    module.start();
    expect(createReadingModeSession).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(
      document.documentElement,
      expect.objectContaining({
        attributeFilter: expect.arrayContaining(['data-value']),
      }),
    );

    contextKey = 'giga-viewer:episode:two:digest-2:https://reader.example/episode/two';
    mutationCallback?.([], {} as MutationObserver);

    await vi.waitFor(() => expect(createReadingModeSession).toHaveBeenCalledTimes(2));
    expect(disposals[0]).toHaveBeenCalledOnce();
    module.dispose();
  });
});
