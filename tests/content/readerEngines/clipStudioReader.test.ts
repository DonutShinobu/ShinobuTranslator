import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipStudioReaderAdapter } from '../../../apps/extension/src/content/readerEngines/clipStudioReader';
import {
  createClipStudioReaderSpreads,
  type ClipStudioReaderContentClient,
  type ClipStudioReaderManifest,
} from '../../../apps/extension/src/content/readerEngines/clipStudioReaderContent';

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

function manifest(): ClipStudioReaderManifest {
  const face = {
    totalPages: 3,
    contentWidth: 1440,
    contentHeight: 2048,
    scrambleColumns: 4,
    scrambleRows: 4,
    binding: 0 as const,
    startPage: 0 as const,
    doublePageIndices: [0],
    blankSingleIndices: [],
  };
  return { face, spreads: createClipStudioReaderSpreads(face) };
}

function createReader(currentPage = 1) {
  let current = currentPage;
  const projections: HTMLImageElement[] = [];
  const canvasPixels = new Uint8ClampedArray(8 * 6 * 4);
  for (let y = 1; y < 5; y += 1) {
    for (let x = 2; x < 6; x += 1) canvasPixels[(y * 8 + x) * 4 + 3] = 255;
  }
  const canvas = {
    isConnected: true,
    width: 8,
    height: 6,
    style: { display: 'block', visibility: 'visible', opacity: '1', zIndex: '1' },
    getBoundingClientRect: () => rect(100, 50, 1280, 720),
    getContext: () => ({ getImageData: () => ({ data: canvasPixels }) }),
  } as unknown as HTMLCanvasElement;
  const screenLayer = {
    isConnected: true,
    style: {},
    parentElement: null,
    querySelectorAll: (selector: string) => selector === 'canvas' ? [canvas] : projections,
    getBoundingClientRect: () => rect(100, 50, 1280, 720),
    appendChild: (element: HTMLImageElement) => {
      Object.defineProperty(element, 'parentElement', { configurable: true, value: screenLayer });
      Object.defineProperty(element, 'isConnected', { configurable: true, value: true });
      if (!projections.includes(element)) projections.push(element);
      return element;
    },
  } as unknown as HTMLElement;
  const root = {
    isConnected: true,
    querySelector: (selector: string) => selector === '#screen_layer' ? screenLayer : null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    contains: () => false,
  } as unknown as HTMLElement;
  const body = {
    appendChild: vi.fn((element: HTMLElement) => {
      Object.defineProperty(element, 'parentElement', { configurable: true, value: body });
      Object.defineProperty(element, 'isConnected', { configurable: true, value: true });
      return element;
    }),
  } as unknown as HTMLElement;
  const document = {
    scripts: [
      { src: 'https://reader.example/celsys/hybrid/js/csr-web-core.js' },
      { src: 'https://reader.example/celsys/hybrid/js/csr-web-player-hybrid.js' },
    ],
    body,
    fullscreenElement: null,
    querySelector: (selector: string) => {
      if (selector === '#stage') return root;
      if (selector === '#menu_nombre_current') return { textContent: String(current) };
      if (selector === '#menu_nombre_total') return { textContent: '4' };
      return null;
    },
    createElement: () => {
      const element = {
        dataset: {},
        style: {},
        alt: '',
        src: '',
        parentElement: null,
        isConnected: false,
        remove() {
          const index = projections.indexOf(element as unknown as HTMLImageElement);
          if (index >= 0) projections.splice(index, 1);
          Object.defineProperty(element, 'parentElement', { configurable: true, value: null });
          Object.defineProperty(element, 'isConnected', { configurable: true, value: false });
        },
      };
      return element as unknown as HTMLElement;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Document;
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    performance: {
      getEntriesByType: () => [{
        name: 'https://reader.example/api/diazepam_hybrid?mode=7&file=face.xml&reqtype=0&param=session&time=1',
      }],
    },
    getComputedStyle: (element: HTMLElement) => element.style,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;
  return {
    canvas,
    document,
    projections,
    root,
    screenLayer,
    setCurrent(value: number) { current = value; },
    window,
  };
}

function contentClient(): ClipStudioReaderContentClient {
  return {
    read: vi.fn(async () => manifest()),
    readPage: vi.fn(async (pageIndex: number) => ({
      pageIndex,
      imageFileName: `${String(pageIndex).padStart(4, '0')}_0000.bin`,
      scrambled: false,
      scrambleTable: [],
    })),
    imageRequest: vi.fn(() => ({
      url: 'https://reader.example/api/page.bin',
      allowedBaseUrl: 'https://reader.example/api/',
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CLIP STUDIO READER adapter', () => {
  it('requires structural CSR evidence and an observed authorized resource endpoint', () => {
    const dom = createReader();
    const adapter = createClipStudioReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer/book/42?token=one' },
      createContentClient: () => contentClient(),
    });

    expect(adapter.detect()).toMatchObject({
      confidence: 'strong',
      root: dom.root,
      sessionAnchor: dom.screenLayer,
      evidence: expect.arrayContaining([
        'CSR Web player script',
        'observed HTTPS diazepam resource protocol',
      ]),
    });
  });

  it('maps the visible CSR counter through the complete spread manifest', async () => {
    const dom = createReader(1);
    const adapter = createClipStudioReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer/book/42?token=one' },
      createContentClient: () => contentClient(),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    await session.discoverReadingPages();

    expect(session.readVisibleSpread().pages[0]).toMatchObject({
      identity: { engineId: 'clip-studio-reader', pageIndex: 0 },
      source: { kind: 'canvas', element: dom.canvas },
    });
    dom.setCurrent(3);
    expect(session.getVisiblePages()[0]).toMatchObject({ pageIndex: 1 });
    expect(await session.discoverReadingPages()).toMatchObject({
      status: 'complete',
      pages: [{ pageIndex: 0 }, { pageIndex: 1 }],
    });
  });

  it('prepares a stable spread and projects it over the original canvas painted bounds', async () => {
    const dom = createReader(1);
    const prepareSpread = vi.fn(async () => new File(['spread'], 'spread.png', { type: 'image/png' }));
    const adapter = createClipStudioReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer/book/42?token=one' },
      createContentClient: () => contentClient(),
      downloadImage: vi.fn(),
      prepareSpread,
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const discovery = await session.discoverReadingPages();
    if (discovery.status !== 'complete') throw new Error('expected complete discovery');

    const prepared = await session.prepareReadingPage!(discovery.pages[0]!, new AbortController().signal);
    expect(prepared.source.kind).toBe('prepared-file');
    expect(prepareSpread).toHaveBeenCalledWith(expect.objectContaining({
      spread: expect.objectContaining({ pageIndex: 0, physicalPageIndices: [0] }),
    }));
    const [prepareOptions] = prepareSpread.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(prepareOptions).not.toHaveProperty('canvasWidth');
    expect(prepareOptions).not.toHaveProperty('canvasHeight');

    session.applyImageByKey(discovery.pages[0]!.key, 'blob:translated');
    expect(dom.projections).toHaveLength(1);
    expect(dom.projections[0]).toMatchObject({ src: 'blob:translated' });
    expect(dom.projections[0]!.style).toMatchObject({
      left: '320px',
      top: '120px',
      width: '640px',
      height: '480px',
      objectFit: 'contain',
    });
    expect(dom.screenLayer.style).not.toHaveProperty('isolation');
    session.applyImageByKey(discovery.pages[0]!.key, discovery.pages[0]!.originalUrl);
    expect(dom.projections).toHaveLength(0);
    expect(dom.screenLayer.style).not.toHaveProperty('isolation');
  });

  it('removes the previous page projection as soon as native navigation is observed', async () => {
    const mutationCallbacks: MutationCallback[] = [];
    class FakeMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallbacks.push(callback);
      }

      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] { return []; }
    }
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    const dom = createReader(1);
    const adapter = createClipStudioReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer/book/42?token=one' },
      createContentClient: () => contentClient(),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const discovery = await session.discoverReadingPages();
    if (discovery.status !== 'complete') throw new Error('expected complete discovery');
    session.applyImageByKey(discovery.pages[0]!.key, 'blob:translated-page-1');
    expect(dom.projections).toHaveLength(1);
    session.observe(vi.fn());

    dom.setCurrent(3);
    const record = {
      type: 'characterData',
      target: dom.root,
      addedNodes: [],
      removedNodes: [],
    } as unknown as MutationRecord;
    expect(mutationCallbacks).toHaveLength(1);
    mutationCallbacks[0]!([record], {} as MutationObserver);

    expect(dom.projections).toHaveLength(0);
  });

});
