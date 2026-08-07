import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComiciReaderEngineAdapter } from '../../../apps/extension/src/content/readerEngines/comici';

function element(overrides: Partial<HTMLElement> = {}): HTMLElement {
  return {
    isConnected: true,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    ...overrides,
  } as unknown as HTMLElement;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function pageSlot(
  classes: readonly string[],
  canvasRect: DOMRect,
): { slot: HTMLElement; canvas: HTMLCanvasElement; anchor: HTMLElement } {
  const canvas = element({
    width: 848,
    height: 1200,
    getBoundingClientRect: () => canvasRect,
  } as Partial<HTMLCanvasElement>) as unknown as HTMLCanvasElement;
  const anchor = element();
  const slot = element({
    classList: { contains: (name: string) => classes.includes(name) } as DOMTokenList,
    querySelector: (selector: string) => {
      if (selector === '.-cv-page-canvas > canvas') return canvas;
      if (selector === '.-cv-page-content') return anchor;
      return null;
    },
  });
  return { slot, canvas, anchor };
}

describe('Comici reader engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires every structural fingerprint and records the evidence', () => {
    const page = element();
    const pages = element({ querySelector: () => page });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
    });
    const selectors = new Map<string, Element>([
      ['#comici-viewer[data-comici-viewer-id].-cv', root],
      ['#xCVPages.-cv-pages', pages],
    ]);
    const document = {
      querySelector: (selector: string) => selectors.get(selector) ?? null,
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });

    expect(adapter.detect()).toEqual({
      confidence: 'strong',
      root,
      sessionAnchor: pages,
      evidence: [
        '#comici-viewer[data-comici-viewer-id].-cv',
        '#xCVPages.-cv-pages',
        '#xCVPages > .-cv-page',
      ],
    });

    selectors.delete('#xCVPages.-cv-pages');
    expect(adapter.detect()).toBeNull();
  });

  it('enumerates visible rendered body pages by stable DOM ordinal', () => {
    const bodyPage = pageSlot(['-cv-page', 'mode-rendered'], rect(10, 5, 40, 80));
    const promotionalPage = pageSlot(
      ['-cv-page', 'mode-rendered', 'mode-pr'],
      rect(50, 5, 40, 80),
    );
    const secondBodyPage = pageSlot(['-cv-page', 'mode-rendered'], rect(50, 5, 40, 80));
    const offscreenPage = pageSlot(['-cv-page', 'mode-rendered'], rect(120, 5, 40, 80));
    const slots = [bodyPage, promotionalPage, secondBodyPage, offscreenPage];
    const pages = element({
      querySelector: () => bodyPage.slot,
      querySelectorAll: () => slots.map((item) => item.slot) as unknown as NodeListOf<Element>,
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
      getBoundingClientRect: () => rect(0, 0, 100, 100),
    });
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });
    const detection = adapter.detect();
    expect(detection).not.toBeNull();

    const session = adapter.createSession(detection!);

    expect(session.contextKey).toBe(
      'comici:viewer-42:https://reader.example/episodes/one',
    );
    expect(session.readVisibleSpread()).toEqual({
      pages: [
        expect.objectContaining({
          identity: {
            engineId: 'comici',
            contextKey: session.contextKey,
            pageIndex: 0,
          },
          slot: bodyPage.slot,
          source: { kind: 'canvas', element: bodyPage.canvas },
          projectionAnchor: bodyPage.anchor,
        }),
        expect.objectContaining({
          identity: {
            engineId: 'comici',
            contextKey: session.contextKey,
            pageIndex: 2,
          },
          slot: secondBodyPage.slot,
          source: { kind: 'canvas', element: secondBodyPage.canvas },
          projectionAnchor: secondBodyPage.anchor,
        }),
      ],
    });
  });

  it('projects engine changes as generic signals and ignores extension nodes', () => {
    let mutationCallback: MutationCallback | undefined;
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });

    const transitionListeners: EventListener[] = [];
    const page = element();
    const pages = element({
      querySelector: () => page,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        transitionListeners.push(listener as EventListener);
      },
      removeEventListener: vi.fn(),
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
    });
    const documentListeners = new Map<string, EventListener>();
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
      addEventListener: (type: string, listener: EventListener) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const adapter = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    });
    const session = adapter.createSession(adapter.detect()!);
    const signals: string[] = [];
    const stop = session.observe((signal) => signals.push(signal.kind));

    mutationCallback?.([{
      type: 'childList',
      target: pages,
      addedNodes: [{
        nodeType: 1,
        getAttribute: (name: string) => name === 'data-mt-projection' ? '' : null,
        querySelector: () => null,
      } as unknown as Node] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord], {} as MutationObserver);
    mutationCallback?.([{
      type: 'attributes',
      attributeName: 'class',
      target: page,
    } as unknown as MutationRecord], {} as MutationObserver);
    resizeCallback?.([], {} as ResizeObserver);
    transitionListeners[0]?.(new Event('transitionend'));
    documentListeners.get('fullscreenchange')?.(new Event('fullscreenchange'));

    expect(signals).toEqual([
      'structure-changed',
      'geometry-changed',
      'render-settled',
      'geometry-changed',
    ]);

    stop();
    session.dispose();
  });

  it('rebinds resize observation when lazy-mounted visible canvases change', () => {
    let mutationCallback: MutationCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    });
    vi.stubGlobal('ResizeObserver', class {
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
    });

    const first = pageSlot(['-cv-page', 'mode-rendered'], rect(0, 0, 100, 100));
    const second = pageSlot(['-cv-page', 'mode-rendered'], rect(0, 0, 100, 100));
    let visible = [first];
    const pages = element({
      querySelector: () => first.slot,
      querySelectorAll: () => visible.map((item) => item.slot) as unknown as NodeListOf<Element>,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const root = element({
      getAttribute: (name) => name === 'data-comici-viewer-id' ? 'viewer-42' : null,
      getBoundingClientRect: () => rect(0, 0, 100, 100),
    });
    const document = {
      querySelector: (selector: string) => {
        if (selector === '#comici-viewer[data-comici-viewer-id].-cv') return root;
        if (selector === '#xCVPages.-cv-pages') return pages;
        return null;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Document;
    const session = createComiciReaderEngineAdapter({
      document,
      location: { origin: 'https://reader.example', pathname: '/episodes/one' },
    }).createSession({ confidence: 'strong', root, evidence: ['fake'] });

    session.observe(() => undefined);
    expect(observe).toHaveBeenCalledWith(first.slot);
    expect(observe).toHaveBeenCalledWith(first.canvas);

    visible = [second];
    mutationCallback?.([{
      type: 'childList',
      target: pages,
      addedNodes: [second.slot] as unknown as NodeList,
      removedNodes: [first.slot] as unknown as NodeList,
    } as unknown as MutationRecord], {} as MutationObserver);

    expect(unobserve).toHaveBeenCalledWith(first.slot);
    expect(unobserve).toHaveBeenCalledWith(first.canvas);
    expect(observe).toHaveBeenCalledWith(second.slot);
    expect(observe).toHaveBeenCalledWith(second.canvas);
  });
});
