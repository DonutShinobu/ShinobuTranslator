import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('browser font initialization diagnostics', () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const add = vi.fn();
  const load = vi.fn(async (): Promise<void> => undefined);
  const constructor = vi.fn();
  const fetchFont = vi.fn();
  function stubBlobUrls(createObjectURL?: (blob: Blob) => string, revokeObjectURL?: (url: string) => void) {
    class TestURL extends URL {}
    Object.defineProperties(TestURL, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal('URL', TestURL);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchFont.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => bytes });
    vi.stubGlobal('fetch', fetchFont);
    vi.stubGlobal('document', { fonts: { add } });
    vi.stubGlobal('FontFace', class {
      constructor(...args: unknown[]) { constructor(...args); }
      load = load;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('records existing font boundaries without changing bytes, descriptors, or deduplication', async () => {
    const records: Record<string, unknown>[] = [];
    vi.stubGlobal('__shinobuColdStartInitMark', (record: Record<string, unknown>) => records.push(record));
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    const descriptors = { style: 'normal', weight: '400' };
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font', descriptors);
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font', descriptors);
    await browserPipelinePlatform.waitForFonts();
    expect(fetchFont).toHaveBeenCalledTimes(1);
    expect(constructor).toHaveBeenCalledWith('Fixture Font', bytes, descriptors);
    expect(load).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(records.map((record) => record.phase)).toEqual(['font.fetch', 'font.body', 'font.face-load', 'font.add', 'font.register']);
    expect(records[1].bytes).toBe(bytes.byteLength);
    expect(records[4].status).toBe('success');
  });

  it('observer exceptions leave the same registered font available', async () => {
    vi.stubGlobal('__shinobuColdStartInitMark', () => { throw new Error('broken diagnostics'); });
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font');
    await browserPipelinePlatform.waitForFonts();
    expect(constructor).toHaveBeenCalledWith('Fixture Font', bytes, undefined);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('a font failure keeps the existing error and does not register a fallback', async () => {
    const records: Record<string, unknown>[] = [];
    vi.stubGlobal('__shinobuColdStartInitMark', (record: Record<string, unknown>) => records.push(record));
    fetchFont.mockResolvedValue({ ok: false, status: 404 });
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font');
    await expect(browserPipelinePlatform.waitForFonts()).rejects.toThrow('字体下载失败: 404');
    expect(add).not.toHaveBeenCalled();
    expect(records.map((record) => record.phase)).toEqual(['font.fetch', 'font.register']);
    expect(records[1].status).toBe('failed');
  });

  it('loads the same bytes/family/descriptors through a Blob URL and revokes after loading', async () => {
    vi.stubGlobal('__shinobuColdStartFontBlobUrl', true);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fixture-font');
    const revokeObjectURL = vi.fn();
    stubBlobUrls(createObjectURL, revokeObjectURL);
    let complete!: () => void;
    const pendingLoad = new Promise<void>(resolve => { complete = resolve; });
    load.mockImplementationOnce(() => pendingLoad);
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    const descriptors = { style: 'normal', weight: '200 900' };
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font', descriptors);
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font', descriptors);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    complete();
    await browserPipelinePlatform.waitForFonts();
    expect(fetchFont).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('font/woff2');
    expect(await blob.arrayBuffer()).toEqual(bytes);
    expect(constructor).toHaveBeenCalledWith('Fixture Font', 'url("blob:fixture-font")', descriptors);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture-font');
    expect(add).toHaveBeenCalledOnce();
  });

  it('a Blob font failure revokes its URL and loads the original binary face', async () => {
    vi.stubGlobal('__shinobuColdStartFontBlobUrl', true);
    const revokeObjectURL = vi.fn();
    stubBlobUrls(() => 'blob:blocked-font', revokeObjectURL);
    load.mockRejectedValueOnce(new Error('font-src blocked')).mockResolvedValueOnce(undefined);
    const records: Record<string, unknown>[] = [];
    vi.stubGlobal('__shinobuColdStartInitMark', (record: Record<string, unknown>) => records.push(record));
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font');
    await browserPipelinePlatform.waitForFonts();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:blocked-font');
    expect(constructor.mock.calls.map(call => call[1])).toEqual(['url("blob:blocked-font")', bytes]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledOnce();
    expect(records.some(record => record.phase === 'font.blob-url-fallback')).toBe(true);
  });

  it('revokes after a URL constructor failure and retains the original binary error', async () => {
    vi.stubGlobal('__shinobuColdStartFontBlobUrl', true);
    const revokeObjectURL = vi.fn();
    stubBlobUrls(() => 'blob:bad-font', revokeObjectURL);
    vi.stubGlobal('FontFace', class {
      constructor(family: string, source: string | ArrayBuffer, descriptors?: unknown) {
        constructor(family, source, descriptors);
        if (typeof source === 'string') throw new Error('URL constructor failed');
      }
      load = load;
    });
    load.mockRejectedValueOnce(new Error('original invalid font data'));
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font');
    await expect(browserPipelinePlatform.waitForFonts()).rejects.toThrow('original invalid font data');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bad-font');
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps the binary path when Blob URLs are unavailable', async () => {
    vi.stubGlobal('__shinobuColdStartFontBlobUrl', true);
    stubBlobUrls();
    const { browserPipelinePlatform } = await import('../../apps/extension/src/shared/browserPipelinePlatform');
    browserPipelinePlatform.registerFont('font.woff2', 'Fixture Font');
    await browserPipelinePlatform.waitForFonts();
    expect(constructor).toHaveBeenCalledWith('Fixture Font', bytes, undefined);
    expect(add).toHaveBeenCalledOnce();
  });
});
