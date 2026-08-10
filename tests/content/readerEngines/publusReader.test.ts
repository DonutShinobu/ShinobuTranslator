import { describe, expect, it, vi } from 'vitest';
import { createPublusReaderAdapter } from '../../../apps/extension/src/content/readerEngines/publusReader';
import {
  PublusReaderInvalidResponseError,
  PublusReaderUnsupportedError,
} from '../../../apps/extension/src/content/readerEngines/publusReaderContent';
import type {
  PublusReaderContentClient,
  PublusReaderResourceFetcher,
} from '../../../apps/extension/src/content/readerEngines/publusReaderContent';

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

function createReader(
  script = 'https://reader.example/js/viewer_image_2.0.29_2025-03-12.js',
  resourceUrls: readonly string[] = [],
) {
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
    performance: {
      getEntriesByType: (type: string) => type === 'resource'
        ? resourceUrls.map((name, index) => ({ name, startTime: index }))
        : [],
    },
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

    const unknownMajor = createReader('https://reader.example/js/viewer_image_3.0.0.js');
    expect(createPublusReaderAdapter({
      document: unknownMajor.document,
      window: unknownMajor.window,
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

  it('preserves a translated page aspect ratio when projecting onto a landscape surface', () => {
    const dom = createReader();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    const visible = session.getVisiblePages()[0]!;

    session.applyImageByKey(visible.key, 'blob:translated');
    expect(dom.projections).toHaveLength(1);
    expect(dom.projections[0]).toMatchObject({ src: 'blob:translated' });
    expect(dom.projections[0]!.style).toMatchObject({
      left: '0px',
      top: '0px',
      width: '960px',
      height: '720px',
      objectFit: 'contain',
      objectPosition: 'center center',
    });
    session.applyImageByKey(visible.key, visible.originalUrl);
    expect(dom.projections).toHaveLength(0);
  });

  it('projects both portrait members of an rtl spread into separate half-screen slots', async () => {
    const dom = createReader();
    const pages = Array.from({ length: 4 }, (_, pageIndex) => ({
      pageIndex,
      width: 100,
      height: 200,
      request: {
        url: `https://assets.example/book/page-${pageIndex}.jpeg`,
        allowedBaseUrl: 'https://assets.example/book/',
      },
      restoration: { kind: 'none' as const },
    }));
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
      createContentClient: (): PublusReaderContentClient => ({
        async read() {
          return { profile: 'v2-plain', pageCount: pages.length, direction: 'rtl', pages };
        },
        async acquirePublusPageFile() {
          return new File(['prepared'], 'page.jpeg', { type: 'image/jpeg' });
        },
      }),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    await session.discoverReadingPages();

    dom.setCounter('1/4');
    const cover = session.getVisiblePages();
    expect(cover.map(({ pageIndex }) => pageIndex)).toEqual([0]);
    session.applyImageByKey(cover[0]!.key, 'blob:cover');
    expect(dom.projections[0]).toMatchObject({
      src: 'blob:cover',
      style: expect.objectContaining({
        left: '0px',
        width: '480px',
        objectPosition: 'right center',
      }),
    });
    session.applyImageByKey(cover[0]!.key, cover[0]!.originalUrl);
    expect(dom.projections).toHaveLength(0);

    dom.setCounter('2/4');
    const visible = session.getVisiblePages();
    expect(visible.map(({ pageIndex }) => pageIndex)).toEqual([1, 2]);

    session.applyImageByKey(visible[0]!.key, 'blob:right-page');
    session.applyImageByKey(visible[1]!.key, 'blob:left-page');
    expect(dom.projections).toHaveLength(2);
    expect(dom.projections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        src: 'blob:right-page',
        dataset: expect.objectContaining({ mtReadingProjectionKey: visible[0]!.key }),
        style: expect.objectContaining({
          left: '480px',
          top: '0px',
          width: '480px',
          height: '720px',
          objectFit: 'contain',
          objectPosition: 'left center',
        }),
      }),
      expect.objectContaining({
        src: 'blob:left-page',
        dataset: expect.objectContaining({ mtReadingProjectionKey: visible[1]!.key }),
        style: expect.objectContaining({
          left: '0px',
          top: '0px',
          width: '480px',
          height: '720px',
          objectFit: 'contain',
          objectPosition: 'right center',
        }),
      }),
    ]));

    dom.setCounter('4/4');
    const trailing = session.getVisiblePages();
    expect(trailing.map(({ pageIndex }) => pageIndex)).toEqual([3]);
    session.applyImageByKey(trailing[0]!.key, 'blob:trailing-page');
    expect(dom.projections).toHaveLength(1);
    expect(dom.projections[0]).toMatchObject({
      src: 'blob:trailing-page',
      style: expect.objectContaining({
        left: '480px',
        width: '480px',
        objectPosition: 'left center',
      }),
    });
  });

  it('discovers and prepares all pages from observed PUBLUS requests on a generic host', async () => {
    const viewerUrl = 'https://reader.example/viewer.html?cid=session-token&cty=1';
    const contentBaseUrl = 'https://assets.example/content/book/';
    const contentCheckUrl = 'https://license.example/content/c?cid=session-token';
    const configurationUrl = `${contentBaseUrl}configuration_pack.json`;
    const dom = createReader(undefined, [contentCheckUrl, configurationUrl]);
    const pack = {
      configuration: {
        contents: [1, 2].map((index) => ({
          file: `OEBPS/text/p-${String(index).padStart(4, '0')}.xhtml`,
          index,
          type: 'jpeg',
        })),
        'page-progression-direction': 'rtl',
      },
      'OEBPS/text/p-0001.xhtml': {
        FileLinkInfo: { PageLinkInfoList: [{ Page: { No: 0, Size: { Width: 100, Height: 200 } } }] },
      },
      'OEBPS/text/p-0002.xhtml': {
        FileLinkInfo: { PageLinkInfoList: [{ Page: { No: 0, Size: { Width: 100, Height: 200 } } }] },
      },
    };
    const fetchResource: PublusReaderResourceFetcher = vi.fn(async (request) => ({
      text: request.url === contentCheckUrl
        ? JSON.stringify({ status: 200, url: contentBaseUrl, lp: 2, cty: 1 })
        : JSON.stringify(pack),
      contentType: 'application/json',
      sourceUrl: request.url,
    }));
    const prepared = new File(['prepared'], 'page.jpeg', { type: 'image/jpeg' });
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: viewerUrl },
      fetchResource,
      downloadImage: async () => ({ file: prepared, blob: prepared }),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    await expect(session.discoverReadingPages()).resolves.toEqual({
      status: 'complete',
      pages: [0, 1].map((pageIndex) => ({
        key: `${session.contextKey}:page:${pageIndex}`,
        originalUrl: `engine-source:${session.contextKey}:page:${pageIndex}`,
        pageIndex,
      })),
    });
    await expect(session.prepareReadingPage!({
      key: `${session.contextKey}:page:1`,
      originalUrl: `engine-source:${session.contextKey}:page:1`,
      pageIndex: 1,
    }, new AbortController().signal)).resolves.toEqual({
      source: { kind: 'prepared-file', file: prepared },
    });
  });

  it('discovers the observed 1.x protocol fingerprint without a domain allowlist', async () => {
    const viewerUrl = 'https://unlisted-reader.example/viewer.html?cid=session-token&cty=1';
    const contentCheckUrl = 'https://license.unlisted.example/permission?cid=session-token';
    const configurationUrl = 'https://assets.unlisted.example/book/configuration_pack.json';
    const dom = createReader(
      'https://unlisted-reader.example/js/viewer_image_1.0.7_2024-09-04.js',
      [contentCheckUrl, configurationUrl],
    );
    const prepared = new File(['prepared'], 'page.png', { type: 'image/png' });
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: viewerUrl },
      createContentClient: ({ readObservedSession }): PublusReaderContentClient => ({
        async read() {
          expect(readObservedSession()).toEqual({
            viewerUrl,
            contentCheckUrl,
            configurationUrl,
            protocolMajor: 1,
          });
          return { profile: 'v1-packed', pageCount: 1, direction: 'rtl', pages: [] };
        },
        async acquirePublusPageFile() { return prepared; },
      }),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    await expect(session.discoverReadingPages()).resolves.toMatchObject({
      status: 'complete',
      pages: [{ pageIndex: 0 }],
    });
  });

  it.each([
    [new PublusReaderUnsupportedError('unknown profile'), 'unsupported-format'],
    [new PublusReaderInvalidResponseError('bad configuration'), 'invalid-response'],
    [new Error('network failed'), 'request-failed'],
  ] as const)('maps content errors without disabling current-page mode', async (error, reason) => {
    const dom = createReader();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location: { href: 'https://reader.example/viewer.html?cid=session-token&cty=1' },
      createContentClient: (): PublusReaderContentClient => ({
        async read() { throw error; },
        async acquirePublusPageFile() { throw error; },
      }),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);

    await expect(session.discoverReadingPages()).resolves.toMatchObject({
      status: 'incomplete',
      reason,
    });
    expect(session.readVisibleSpread().pages).toHaveLength(1);
  });

  it('fails closed when the viewer context changes before discovery', async () => {
    const dom = createReader();
    const location = { href: 'https://reader.example/viewer.html?cid=first&cty=1' };
    const read = vi.fn();
    const adapter = createPublusReaderAdapter({
      document: dom.document,
      window: dom.window,
      location,
      createContentClient: (): PublusReaderContentClient => ({
        read,
        async acquirePublusPageFile() { throw new Error('must not prepare'); },
      }),
    });
    const session = adapter.createReadingModeSession!(adapter.detect()!);
    location.href = 'https://reader.example/viewer.html?cid=second&cty=1';

    await expect(session.discoverReadingPages()).resolves.toEqual({
      status: 'incomplete',
      reason: 'metadata-unavailable',
    });
    expect(read).not.toHaveBeenCalled();
  });
});
