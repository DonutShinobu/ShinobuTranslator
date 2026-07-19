import { afterEach, describe, expect, it, vi } from 'vitest';
import { twitterAdapter } from '../../../src/content/adapters/twitter';
import { PhotoStateStore } from '../../../src/content/core/state/photoStateStore';
import { ImageTranslationController } from '../../../src/content/core/translation/imageTranslationController';
import { TranslationRunner } from '../../../src/content/core/translation/translationRunner';

describe('twitterAdapter.observe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resyncs when X reuses the photo viewer image for another source', () => {
    let mutationCallback: MutationCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();

    class FakeMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
      takeRecords = vi.fn(() => []);
    }

    const pushState = vi.fn();
    const replaceState = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const body = {};
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      body,
    });
    vi.stubGlobal('history', { pushState, replaceState });
    vi.stubGlobal('window', { addEventListener, removeEventListener });

    const onChange = vi.fn();
    const dispose = twitterAdapter.observe(onChange);

    expect(observe).toHaveBeenCalledWith(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });

    expect(mutationCallback).not.toBeNull();
    (mutationCallback as unknown as MutationCallback)(
      [{
        type: 'attributes',
        attributeName: 'src',
        target: {},
      } as MutationRecord],
      {} as MutationObserver,
    );

    expect(onChange).toHaveBeenCalledOnce();
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not resync for the source mutation made when applying a translation', () => {
    let mutationCallback: MutationCallback | null = null;

    class FakeImageElement {
      src = '';
      previousElementSibling = null;
      setAttribute = vi.fn();
    }

    class FakeMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }

      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    vi.stubGlobal('HTMLImageElement', FakeImageElement);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      body: {},
    });
    vi.stubGlobal('history', {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const onChange = vi.fn();
    const dispose = twitterAdapter.observe(onChange);
    const element = new FakeImageElement();

    twitterAdapter.applyImage(
      {
        element: element as unknown as HTMLImageElement,
        key: 'first-image',
        originalUrl: 'https://pbs.twimg.com/media/first?format=jpg',
      },
      'blob:translated',
    );
    expect(mutationCallback).not.toBeNull();
    (mutationCallback as unknown as MutationCallback)(
      [{
        type: 'attributes',
        attributeName: 'src',
        target: element,
      } as unknown as MutationRecord],
      {} as MutationObserver,
    );

    expect(onChange).not.toHaveBeenCalled();
    dispose();
  });
});

describe('twitterAdapter.findImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps display state separate when equal-sized carousel images swap into view', async () => {
    type Rect = {
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      height: number;
    };

    class FakeElement {}

    class FakeImageElement extends FakeElement {
      currentSrc = '';
      previousElementSibling = null;
      private readonly attributes = new Map<string, string>();

      constructor(
        public src: string,
        public rect: Rect,
      ) {
        super();
      }

      getBoundingClientRect() {
        return this.rect;
      }

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      hasAttribute(name: string) {
        return this.attributes.has(name);
      }

      removeAttribute(name: string) {
        this.attributes.delete(name);
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }
    }

    const centeredRect: Rect = {
      left: 200,
      right: 1000,
      top: 100,
      bottom: 700,
      width: 800,
      height: 600,
    };
    const offscreenRect: Rect = {
      left: -900,
      right: -100,
      top: 100,
      bottom: 700,
      width: 800,
      height: 600,
    };
    const firstImage = new FakeImageElement(
      'https://pbs.twimg.com/media/first?format=jpg&name=large',
      centeredRect,
    );
    const secondImage = new FakeImageElement(
      'https://pbs.twimg.com/media/second?format=jpg&name=large',
      offscreenRect,
    );
    const dialog = {
      contains: (element: unknown) => element === firstImage || element === secondImage,
      getBoundingClientRect: () => ({
        left: 0,
        right: 1200,
        top: 0,
        bottom: 800,
        width: 1200,
        height: 800,
      }),
      querySelectorAll: vi.fn(() => [firstImage, secondImage]),
    };

    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLImageElement', FakeImageElement);
    vi.stubGlobal('document', {
      elementFromPoint: vi.fn(() => ({ closest: vi.fn(() => null) })),
      querySelectorAll: vi.fn(() => [dialog]),
    });
    vi.stubGlobal('window', {
      innerWidth: 1200,
      innerHeight: 800,
      getComputedStyle: vi.fn(() => ({
        display: 'block',
        visibility: 'visible',
      })),
    });

    const firstTarget = twitterAdapter.findImages()[0];
    firstImage.rect = offscreenRect;
    secondImage.rect = centeredRect;
    const secondTarget = twitterAdapter.findImages()[0];

    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const firstState = store.ensure(firstTarget.key, firstTarget.originalUrl);
    firstState.translatedUrl = 'blob:first-translated';
    firstState.mode = 'translated';
    firstState.status = 'translated';
    const secondState = store.ensure(secondTarget.key, secondTarget.originalUrl);
    secondState.translatedUrl = 'blob:second-translated';
    secondState.mode = 'translated';
    secondState.status = 'translated';
    const controller = new ImageTranslationController(
      store,
      new TranslationRunner(),
      {
        resolveTarget: (key) => key === firstTarget.key ? firstTarget : secondTarget,
        applyImage: vi.fn(),
        render: vi.fn(),
      },
    );

    await controller.handleTranslateClick(firstTarget);

    expect(firstState.mode).toBe('original');
    expect(firstState.status).toBe('showingOriginal');
    expect(secondState.mode).toBe('translated');
    expect(secondState.status).toBe('translated');
    expect(firstTarget.key).toBe('https://pbs.twimg.com/media/first?format=jpg');
    expect(secondTarget.key).toBe('https://pbs.twimg.com/media/second?format=jpg');
    expect(secondTarget.key).not.toBe(firstTarget.key);
  });
});
