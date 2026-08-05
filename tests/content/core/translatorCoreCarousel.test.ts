import { afterEach, describe, expect, it, vi } from 'vitest';
import { twitterAdapter } from '../../../apps/extension/src/content/adapters/twitter';
import { TranslatorCore } from '../../../apps/extension/src/content/core/TranslatorCore';
import type { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import type {
  ImageTarget,
  SiteAdapter,
} from '../../../apps/extension/src/content/core/types';
import type {
  ImageTranslationCallbacks,
  ImageTranslationController,
} from '../../../apps/extension/src/content/core/translation/imageTranslationController';

const uiMocks = vi.hoisted(() => ({
  createUiElements: vi.fn(() => {
    const host = {
      isConnected: false,
      remove: vi.fn(),
    };
    host.remove.mockImplementation(() => {
      host.isConnected = false;
    });
    return {
      host,
      button: { addEventListener: vi.fn() },
      stageTimingCardToggleButton: { addEventListener: vi.fn() },
      errorDetailCardToggleButton: { addEventListener: vi.fn() },
    };
  }),
  injectStyles: vi.fn(),
  renderUi: vi.fn(),
}));

vi.mock('../../../apps/extension/src/content/core/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../apps/extension/src/content/core/ui')>(),
  ...uiMocks,
}));

function imageTarget(key: string): ImageTarget {
  return {
    element: {} as HTMLImageElement,
    key,
    originalUrl: key.split('::')[1] ?? key,
  };
}

function createHarness() {
  const first = imageTarget(
    'status:123::https://pbs.twimg.com/media/first?format=jpg',
  );
  const second = imageTarget(
    'status:123::https://pbs.twimg.com/media/second?format=jpg',
  );
  const otherTweet = imageTarget(
    'status:456::https://pbs.twimg.com/media/other?format=jpg',
  );
  let targets = [first];
  const applyImage = vi.fn();
  const adapter: SiteAdapter = {
    ...twitterAdapter,
    findImages: () => targets,
    createUiAnchor: () => ({
      appendChild(host: { isConnected: boolean }) {
        host.isConnected = true;
      },
    }) as unknown as HTMLElement,
    applyImage,
    observe: () => () => undefined,
  };
  const core = new TranslatorCore(adapter);
  const controller = Reflect.get(core, 'imageTranslationController') as ImageTranslationController;
  const stateStore = Reflect.get(core, 'stateStore') as PhotoStateStore;

  return {
    first,
    second,
    otherTweet,
    applyImage,
    controller,
    stateStore,
    core,
    setTargets(next: ImageTarget[]) {
      targets = next;
    },
    sync() {
      Reflect.get(core, 'sync').call(core);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('TranslatorCore x.com carousel lifecycle', () => {
  it('keeps A active while the same tweet carousel is displaying B', () => {
    const harness = createHarness();
    const cancel = vi.spyOn(harness.controller, 'cancel');
    harness.core.start();

    harness.setTargets([harness.second]);
    harness.sync();

    expect(cancel).not.toHaveBeenCalledWith(harness.first.key);
  });

  it.each([
    { name: 'the photo viewer closes', targets: [] },
    { name: 'a different tweet opens', targets: ['otherTweet'] as const },
  ])('cancels A when $name', ({ targets }) => {
    const harness = createHarness();
    const cancel = vi.spyOn(harness.controller, 'cancel');
    harness.core.start();

    harness.setTargets(
      targets.length === 0 ? [] : [harness.otherTweet],
    );
    harness.sync();

    expect(cancel).toHaveBeenCalledWith(harness.first.key);
  });

  it('does not apply A completion to B and restores it when A remounts', () => {
    const harness = createHarness();
    harness.core.start();
    harness.setTargets([harness.second]);
    harness.sync();
    harness.applyImage.mockClear();

    const firstState = harness.stateStore.ensure(
      harness.first.key,
      harness.first.originalUrl,
    );
    firstState.translatedUrl = 'blob:first-translated';
    firstState.status = 'translated';
    firstState.mode = 'translated';
    const callbacks = Reflect.get(
      harness.controller,
      'callbacks',
    ) as ImageTranslationCallbacks;

    callbacks.applyImage(harness.first, firstState);
    expect(harness.applyImage).not.toHaveBeenCalled();

    harness.setTargets([harness.first]);
    harness.sync();
    expect(harness.applyImage).toHaveBeenCalledWith(
      harness.first,
      'blob:first-translated',
    );
  });
});
