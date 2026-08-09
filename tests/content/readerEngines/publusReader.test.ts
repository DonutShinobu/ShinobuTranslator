import { describe, expect, it, vi } from 'vitest';
import { createPublusReaderAdapter } from '../../../apps/extension/src/content/readerEngines/publusReader';

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

function createReader(script = 'https://reader.example/js/viewer_image_2.0.29_2025-03-12.js') {
  let counter = '1/26';
  const projections: HTMLImageElement[] = [];
  const hiddenViewport = {
    id: 'viewport0',
    isConnected: true,
    style: { visibility: 'hidden', display: 'block', opacity: '1', zIndex: '10' },
  } as unknown as HTMLElement;
  const activeViewport = {
    id: 'viewport1',
    isConnected: true,
    style: { visibility: 'visible', display: 'block', opacity: '1', zIndex: '0' },
    getBoundingClientRect: () => rect(200, 100, 960, 720),
    querySelectorAll: () => projections,
    appendChild: (element: HTMLImageElement) => {
      Object.defineProperty(element, 'parentElement', { configurable: true, value: activeViewport });
      projections.push(element);
      return element;
    },
  } as unknown as HTMLElement;
  const hiddenCanvas = {
    isConnected: true,
    style: { visibility: 'visible', display: 'block', opacity: '1' },
    closest: () => hiddenViewport,
    getBoundingClientRect: () => rect(200, 100, 960, 720),
  } as unknown as HTMLCanvasElement;
  const activeCanvas = {
    isConnected: true,
    width: 1920,
    height: 1440,
    style: { visibility: 'visible', display: 'block', opacity: '1' },
    closest: () => activeViewport,
    getBoundingClientRect: () => rect(200, 100, 960, 720),
  } as unknown as HTMLCanvasElement;
  const canvases = [hiddenCanvas, activeCanvas];
  const renderer = {
    isConnected: true,
    querySelector: () => activeCanvas,
    querySelectorAll: () => canvases,
  } as unknown as HTMLElement;
  const root = {
    isConnected: true,
    querySelector: (selector: string) => selector === '#renderer' ? renderer : null,
    querySelectorAll: () => projections,
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
    scripts: [{ src: script }],
    body,
    fullscreenElement: null,
    querySelector: (selector: string) => {
      if (selector === '#viewer.viewer, #viewer') return root;
      if (selector === '#pageSliderCounter') return { textContent: counter };
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
        },
      };
      return element as unknown as HTMLElement;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Document;
  const window = {
    innerWidth: 1600,
    innerHeight: 1000,
    getComputedStyle: (element: HTMLElement) => element.style,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window;
  return {
    activeCanvas,
    activeViewport,
    document,
    projections,
    renderer,
    root,
    setCounter(value: string) { counter = value; },
    window,
  };
}

describe('PUBLUS Reader adapter', () => {
  it('requires the fixed-layout viewer_image runtime instead of matching generic EPUB readers', () => {
    const dom = createReader();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
    });

    expect(adapter.detect()).toMatchObject({
      confidence: 'strong',
      root: dom.root,
      sessionAnchor: dom.renderer,
      evidence: expect.arrayContaining(['PUBLUS viewer_image script', '#pageSliderCounter']),
    });

    const reflow = createReader('https://reader.example/js/viewer_1.0.1_2016-04-15.js');
    expect(createPublusReaderAdapter({
      document: reflow.document,
      window: reflow.window,
      location: { href: 'https://reader.example/viewer.html?cid=text' },
    }).detect()).toBeNull();
  });

  it('chooses the actually visible viewport rather than a stale current-screen class', () => {
    const dom = createReader();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    expect(session.readVisibleSpread().pages[0]).toMatchObject({
      identity: { engineId: 'publus-reader', pageIndex: 0 },
      slot: dom.activeViewport,
      source: { kind: 'canvas', element: dom.activeCanvas },
    });
    dom.setCounter('7/26');
    expect(session.getVisiblePages()[0]).toMatchObject({ pageIndex: 6 });
  });

  it('supports current-page projection and reports translate-all as explicitly unsupported', async () => {
    const dom = createReader();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const visible = session.getVisiblePages()[0]!;

    expect(await session.discoverReadingPages()).toEqual({
      status: 'incomplete',
      reason: 'unsupported-format',
      detail: expect.stringContaining('当前显示页'),
    });
    session.applyImageByKey(visible.key, 'blob:translated');
    expect(dom.projections).toHaveLength(1);
    expect(dom.projections[0]).toMatchObject({ src: 'blob:translated' });
    expect(dom.projections[0]!.style).toMatchObject({
      left: '0px',
      top: '0px',
      width: '960px',
      height: '720px',
    });
    session.applyImageByKey(visible.key, visible.originalUrl);
    expect(dom.projections).toHaveLength(0);
  });
});
