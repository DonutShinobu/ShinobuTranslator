import { afterEach, describe, expect, it, vi } from 'vitest';
import { twitterAdapter } from '../../../apps/extension/src/content/adapters/twitter';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import { ImageTranslationController } from '../../../apps/extension/src/content/core/translation/imageTranslationController';
import { createImageTranslationExecutionModule } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';

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
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => [firstImage, secondImage]),
    };

    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLImageElement', FakeImageElement);
    vi.stubGlobal('document', {
      elementFromPoint: vi.fn(() => ({ closest: vi.fn(() => null) })),
      querySelectorAll: vi.fn((selector: string) => (
        selector === '[aria-labelledby="modal-header"][role="dialog"]' ? [dialog] : []
      )),
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
      createImageTranslationExecutionArbiter(createImageTranslationExecutionModule({
        loadSettings: async () => ({ ...defaultExtensionSettings }),
      })),
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
    expect(firstTarget.key).toContain('::https://pbs.twimg.com/media/first?format=jpg');
    expect(secondTarget.key).toContain('::https://pbs.twimg.com/media/second?format=jpg');
    expect(secondTarget.key).not.toBe(firstTarget.key);
  });

  it('treats the same media URL in different tweets as different images', () => {
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
        private readonly rect: Rect,
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

    const image = new FakeImageElement(
      'https://pbs.twimg.com/media/shared?format=jpg&name=large',
      {
        left: 100,
        right: 900,
        top: 100,
        bottom: 700,
        width: 800,
        height: 600,
      },
    );
    let statusLinks: Array<{ href: string; closest: () => unknown }> = [];
    const dialog = {
      contains: (element: unknown) => element === image,
      getBoundingClientRect: () => ({
        left: 0,
        right: 1000,
        top: 0,
        bottom: 800,
        width: 1000,
        height: 800,
      }),
      querySelector: vi.fn((selector: string) => (
        selector === 'a[href*="/status/"]' ? statusLinks[0] ?? null : null
      )),
      querySelectorAll: vi.fn((selector: string) => (
        selector === 'img' ? [image] : statusLinks
      )),
    };
    const locationState = {
      hostname: 'x.com',
      pathname: '/alice/status/111/photo/1',
    };

    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLImageElement', FakeImageElement);
    vi.stubGlobal('location', locationState);
    vi.stubGlobal('document', {
      elementFromPoint: vi.fn(() => image),
      querySelectorAll: vi.fn((selector: string) => (
        selector === '[aria-labelledby="modal-header"][role="dialog"]' ? [dialog] : []
      )),
    });
    vi.stubGlobal('window', {
      innerWidth: 1000,
      innerHeight: 800,
      getComputedStyle: vi.fn(() => ({
        display: 'block',
        visibility: 'visible',
      })),
    });

    const firstKey = twitterAdapter.findImages()[0].key;
    locationState.pathname = '/bob/status/222/photo/1';
    const secondKey = twitterAdapter.findImages()[0].key;
    locationState.pathname = '/alice/status/111/photo/1';
    const reopenedFirstKey = twitterAdapter.findImages()[0].key;

    expect(secondKey).not.toBe(firstKey);
    expect(reopenedFirstKey).toBe(firstKey);

    locationState.pathname = '/home';
    statusLinks = [{
      href: 'https://x.com/quoted/status/999',
      closest: () => ({}),
    }];
    const quoteOnlyKey = twitterAdapter.findImages()[0].key;
    expect(quoteOnlyKey).not.toContain('status:999');
    expect(quoteOnlyKey).toContain('dialog:');

    statusLinks = [
      ...statusLinks,
      {
        href: 'https://x.com/alice/status/333',
        closest: () => null,
      },
    ];
    const linkedCurrentTweetKey = twitterAdapter.findImages()[0].key;
    expect(linkedCurrentTweetKey).toContain('status:333');
  });
});

describe('twitterAdapter.getTranslationContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures the current and quoted tweet bodies from the photo dialog', () => {
    class FakeElement {}

    const currentBody = Object.assign(new FakeElement(), {
      innerText: '今日の漫画😊\n@shinobu #翻訳 https://example.com',
    });
    const quotedBody = Object.assign(new FakeElement(), {
      innerText: '引用された投稿',
    });
    const quoteCard = Object.assign(new FakeElement(), {
      contains: vi.fn((node: unknown) => node === quotedBody),
      querySelector: vi.fn(() => null),
    });
    const tweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '[data-testid="tweetText"]') return [currentBody, quotedBody];
        if (selector === '[role="link"]:has([data-testid="Tweet-User-Avatar"])') return [quoteCard];
        return [];
      }),
    });
    const dialog = Object.assign(new FakeElement(), {
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? tweet : null
      )),
    });
    const image = Object.assign(new FakeElement(), {
      closest: vi.fn(() => dialog),
    }) as unknown as HTMLImageElement;

    vi.stubGlobal('HTMLElement', FakeElement);

    const result = twitterAdapter.getTranslationContext?.({
      element: image,
      key: 'tweet:123:image',
      originalUrl: 'https://pbs.twimg.com/media/example?format=jpg',
    });

    expect(result).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: '今日の漫画😊\n@shinobu #翻訳 https://example.com',
        quotedTweetText: '引用された投稿',
      },
    });
  });

  it('prefers the original body and falls back to a rendered X translation when the original is empty', () => {
    class FakeElement {}

    const currentOriginal = Object.assign(new FakeElement(), {
      innerText: '当前推文原文',
    });
    const currentTranslated = Object.assign(new FakeElement(), {
      innerText: '当前推文的 X 翻译',
    });
    const quotedOriginal = Object.assign(new FakeElement(), {
      innerText: '',
    });
    const quotedTranslated = Object.assign(new FakeElement(), {
      innerText: '引用推文的 X 翻译',
    });
    const quoteCard = Object.assign(new FakeElement(), {
      contains: vi.fn((node: unknown) => (
        node === quotedOriginal || node === quotedTranslated
      )),
      querySelector: vi.fn(() => null),
    });
    const tweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '[data-testid="tweetText"]') {
          return [
            currentOriginal,
            currentTranslated,
            quotedOriginal,
            quotedTranslated,
          ];
        }
        if (selector === '[role="link"]:has([data-testid="Tweet-User-Avatar"])') {
          return [quoteCard];
        }
        return [];
      }),
    });
    const dialog = Object.assign(new FakeElement(), {
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? tweet : null
      )),
    });
    const image = Object.assign(new FakeElement(), {
      closest: vi.fn(() => dialog),
    }) as unknown as HTMLImageElement;

    vi.stubGlobal('HTMLElement', FakeElement);

    expect(twitterAdapter.getTranslationContext?.({
      element: image,
      key: 'tweet:123:image',
      originalUrl: 'https://pbs.twimg.com/media/example?format=jpg',
    })).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: '当前推文原文',
        quotedTweetText: '引用推文的 X 翻译',
      },
    });
  });

  it('rejects partial context when a quoted tweet card cannot be read', () => {
    class FakeElement {}

    const currentBody = Object.assign(new FakeElement(), {
      innerText: '当前推文正文',
    });
    const unreadableQuoteCard = Object.assign(new FakeElement(), {
      contains: vi.fn(() => false),
      querySelector: vi.fn(() => null),
    });
    const tweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '[data-testid="tweetText"]') return [currentBody];
        if (selector === '[role="link"]:has([data-testid="Tweet-User-Avatar"])') {
          return [unreadableQuoteCard];
        }
        return [];
      }),
    });
    const dialog = Object.assign(new FakeElement(), {
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? tweet : null
      )),
    });
    const image = Object.assign(new FakeElement(), {
      closest: vi.fn(() => dialog),
    }) as unknown as HTMLImageElement;

    vi.stubGlobal('HTMLElement', FakeElement);

    const result = twitterAdapter.getTranslationContext?.({
      element: image,
      key: 'tweet:123:image',
      originalUrl: 'https://pbs.twimg.com/media/example?format=jpg',
    });

    expect(result).toEqual({ status: 'unavailable' });
  });

  it('preserves blank lines in the rendered tweet body', () => {
    class FakeElement {}

    const currentBody = Object.assign(new FakeElement(), {
      innerText: '第一行\n\n\n第二行',
    });
    const tweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => (
        selector === '[data-testid="tweetText"]' ? [currentBody] : []
      )),
    });
    const dialog = Object.assign(new FakeElement(), {
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? tweet : null
      )),
    });
    const image = Object.assign(new FakeElement(), {
      closest: vi.fn(() => dialog),
    }) as unknown as HTMLImageElement;

    vi.stubGlobal('HTMLElement', FakeElement);

    expect(twitterAdapter.getTranslationContext?.({
      element: image,
      key: 'tweet:123:image',
      originalUrl: 'https://pbs.twimg.com/media/example?format=jpg',
    })).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: '第一行\n\n\n第二行',
      },
    });
  });

  it('treats empty tweet bodies and media-only quoted tweets as legal empty context', () => {
    class FakeElement {}

    const currentBody = Object.assign(new FakeElement(), {
      innerText: '当前推文正文',
    });
    const quoteCard = Object.assign(new FakeElement(), {
      contains: vi.fn(() => false),
      querySelector: vi.fn((selector: string) => (
        selector === '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video'
          ? new FakeElement()
          : null
      )),
    });
    const tweetWithMediaQuote = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '[data-testid="tweetText"]') return [currentBody];
        if (selector === '[role="link"]:has([data-testid="Tweet-User-Avatar"])') return [quoteCard];
        return [];
      }),
    });
    const emptyTweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn(() => []),
    });
    let activeTweet = tweetWithMediaQuote;
    const dialog = Object.assign(new FakeElement(), {
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? activeTweet : null
      )),
    });
    const image = Object.assign(new FakeElement(), {
      closest: vi.fn(() => dialog),
    }) as unknown as HTMLImageElement;
    const target = {
      element: image,
      key: 'tweet:123:image',
      originalUrl: 'https://pbs.twimg.com/media/example?format=jpg',
    };

    vi.stubGlobal('HTMLElement', FakeElement);

    expect(twitterAdapter.getTranslationContext?.(target)).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: '当前推文正文',
        quotedTweetText: '',
      },
    });

    activeTweet = emptyTweet;
    expect(twitterAdapter.getTranslationContext?.(target)).toEqual({
      status: 'empty',
    });
  });

  it('uses cached or matching timeline context when the photo sidebar is absent', () => {
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
      closest = vi.fn();
      private readonly attributes = new Map<string, string>();

      constructor(
        public src: string,
        private readonly rect: Rect,
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

    const currentBody = Object.assign(new FakeElement(), {
      innerText: '侧边栏关闭前可见的推文正文',
    });
    const tweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => (
        selector === '[data-testid="tweetText"]' ? [currentBody] : []
      )),
    });
    const emptyTweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn(() => []),
    });
    const image = new FakeImageElement(
      'https://pbs.twimg.com/media/example?format=jpg&name=large',
      {
        left: 100,
        right: 900,
        top: 100,
        bottom: 700,
        width: 800,
        height: 600,
      },
    );
    let activeTweet: typeof tweet | null = tweet;
    const dialog = Object.assign(new FakeElement(), {
      contains: (element: unknown) => element === image,
      getBoundingClientRect: () => ({
        left: 0,
        right: 1000,
        top: 0,
        bottom: 800,
        width: 1000,
        height: 800,
      }),
      querySelector: vi.fn((selector: string) => (
        selector === 'article[data-testid="tweet"]' ? activeTweet : null
      )),
      querySelectorAll: vi.fn((selector: string) => (
        selector === 'img' ? [image] : []
      )),
    });
    image.closest.mockReturnValue(dialog);
    let timelineTweets: FakeElement[] = [];

    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLImageElement', FakeImageElement);
    const locationState = {
      hostname: 'x.com',
      pathname: '/alice/status/123/photo/1',
    };
    vi.stubGlobal('location', locationState);
    vi.stubGlobal('document', {
      elementFromPoint: vi.fn(() => image),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '[aria-labelledby="modal-header"][role="dialog"]') return [dialog];
        if (selector === 'article[data-testid="tweet"]') return timelineTweets;
        return [];
      }),
    });
    vi.stubGlobal('window', {
      innerWidth: 1000,
      innerHeight: 800,
      getComputedStyle: vi.fn(() => ({
        display: 'block',
        visibility: 'visible',
      })),
    });

    const target = twitterAdapter.findImages()[0];
    activeTweet = null;

    expect(twitterAdapter.getTranslationContext?.(target)).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: '侧边栏关闭前可见的推文正文',
      },
    });

    locationState.pathname = '/bob/status/456/photo/1';
    const uncachedTarget = twitterAdapter.findImages()[0];
    expect(twitterAdapter.getTranslationContext?.(uncachedTarget)).toEqual({
      status: 'unavailable',
    });

    locationState.pathname = '/carol/status/789/photo/1';
    activeTweet = emptyTweet;
    const emptyTarget = twitterAdapter.findImages()[0];
    activeTweet = null;
    expect(twitterAdapter.getTranslationContext?.(emptyTarget)).toEqual({
      status: 'empty',
    });

    const unrelatedBody = Object.assign(new FakeElement(), {
      innerText: '不应作为上下文的其他推文',
    });
    const unrelatedStatusLink = {
      href: 'https://x.com/other/status/998',
      closest: vi.fn(() => null),
    };
    const unrelatedTweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === 'a[href*="/status/"]') return [unrelatedStatusLink];
        if (selector === '[data-testid="tweetText"]') return [unrelatedBody];
        return [];
      }),
    });
    const timelineBody = Object.assign(new FakeElement(), {
      innerText: 'timeline 中的当前推文正文',
    });
    const timelineQuotedBody = Object.assign(new FakeElement(), {
      innerText: 'timeline 中的引用推文正文',
    });
    const timelineQuoteCard = Object.assign(new FakeElement(), {
      contains: vi.fn((node: unknown) => node === timelineQuotedBody),
      querySelector: vi.fn(() => null),
    });
    const timelineStatusLink = {
      href: 'https://x.com/dave/status/999',
      closest: vi.fn(() => null),
    };
    const timelineQuotedStatusLink = {
      href: 'https://x.com/quoted/status/991',
      closest: vi.fn(() => timelineQuoteCard),
    };
    const timelineMediaImage = {
      src: 'https://pbs.twimg.com/media/example?format=jpg&name=small',
      currentSrc: '',
      closest: vi.fn(() => null),
    };
    const timelineTweet = Object.assign(new FakeElement(), {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === 'a[href*="/status/"]') {
          return [timelineQuotedStatusLink, timelineStatusLink];
        }
        if (selector === '[data-testid="tweetText"]') {
          return [timelineBody, timelineQuotedBody];
        }
        if (selector === '[role="link"]:has([data-testid="Tweet-User-Avatar"])') {
          return [timelineQuoteCard];
        }
        if (selector === 'img') return [timelineMediaImage];
        return [];
      }),
    });

    locationState.pathname = '/home';
    timelineTweets = [unrelatedTweet, timelineTweet];
    const timelineTarget = twitterAdapter.findImages()[0];
    timelineTweets = [];

    expect(twitterAdapter.getTranslationContext?.(timelineTarget)).toEqual({
      status: 'available',
      context: {
        source: 'x_tweet',
        currentTweetText: 'timeline 中的当前推文正文',
        quotedTweetText: 'timeline 中的引用推文正文',
      },
    });
  });
});
