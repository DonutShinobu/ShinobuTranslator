import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshButtonContrast } from '../../../apps/extension/src/content/core/ui/buttonContrast';

let nextImage = 0;

function fixture(rgb: number[], tagName = 'IMG', mixed = false, splitAt = 8) {
  const properties = new Map<string, string>();
  const sourceStyle = {
    backgroundImage: 'none', backgroundColor: 'transparent', opacity: '1', filter: 'none',
    transform: 'none', objectFit: 'cover', objectPosition: 'right center',
    getPropertyValue: () => '0px',
  };
  const backgroundStyle = { ...sourceStyle, backgroundColor: 'rgb(255, 255, 255)' };
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const image = {
    tagName, complete: true, naturalWidth: 1000, naturalHeight: 500, width: 1000, height: 500,
    offsetWidth: 200, offsetHeight: 200, currentSrc: `https://contrast.example/${++nextImage}.png`, src: '',
    getBoundingClientRect: () => rect(0, 0, 200, 200), closest: () => null,
  };
  const background = { tagName: 'DIV', closest: () => null };
  const foreground = (left: number, top: number, width: number, height: number) => {
    const colors = new Map<string, string>();
    return {
      getBoundingClientRect: () => rect(left, top, width, height), dataset: {} as Record<string, string>, colors,
      style: { setProperty: (key: string, value: string) => colors.set(key, value), removeProperty: (key: string) => colors.delete(key) },
    };
  };
  const icon = foreground(110, 89, 16, 16);
  const label = foreground(135, 87, 45, 20);
  const glyphs = mixed ? [foreground(135, 87, 10, 20), foreground(155, 87, 10, 20)] : [];
  const overlay = { contains: (element: unknown) => element === button || element === icon || element === label };
  let unreadable = false, tainted = false;
  let pixels = new Uint8ClampedArray(16 * 6 * 4);
  const fill = (x: number, width: number, color: number[]) => {
    for (let y = 0; y < 6; y++) for (let px = x; px < x + width; px++) pixels.set(color, (y * 16 + px) * 4);
  };
  const context = {
    filter: 'none', globalAlpha: 1, fillStyle: '',
    clearRect: (x: number, _y: number, width: number) => fill(x, width, [0, 0, 0, 0]),
    fillRect: (x: number, _y: number, width: number) => fill(x, width, [255, 255, 255, 255]),
    drawImage: vi.fn((_source: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, _dy: number, dw: number, _dh: number) => {
      if (unreadable) tainted = true;
      for (let px = dx; px < dx + dw; px++) fill(px, 1, [...(mixed && px >= splitAt ? [255, 255, 255] : rgb), 255]);
    }),
    getImageData: (x: number, y: number, width: number, height: number) => {
      if (tainted) throw new DOMException('Unclean canvas', 'SecurityError');
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        data.set(pixels.subarray(((y + row) * 16 + x + col) * 4, ((y + row) * 16 + x + col) * 4 + 4), (row * width + col) * 4);
      }
      return { data };
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const doc = {
    defaultView: { getComputedStyle: (element: unknown) => element === image ? sourceStyle : backgroundStyle },
    elementsFromPoint: vi.fn(() => [button, image, background]),
    createElement: vi.fn(() => { pixels = new Uint8ClampedArray(16 * 6 * 4); tainted = false; return canvas; }),
  };
  const button = {
    ownerDocument: doc, isConnected: true, dataset: {} as Record<string, string>,
    style: { setProperty: (key: string, value: string) => properties.set(key, value), getPropertyValue: (key: string) => properties.get(key) || '' },
    closest: () => overlay, getBoundingClientRect: () => rect(100, 80, 90, 36),
    querySelectorAll: (selector: string) => {
      if (selector === '.mt-x-label-slot, .mt-x-icon') return [icon, label];
      if (selector === '.mt-x-icon') return [icon];
      if (selector === '.mt-x-label') return [label];
      return [...glyphs, icon, label];
    },
  };
  vi.stubGlobal('getComputedStyle', doc.defaultView.getComputedStyle);
  return {
    button: button as unknown as HTMLButtonElement, source: image, sourceStyle, properties, context, doc, canvas, glyphs, icon, label,
    unreadable: () => { unreadable = true; }, readable: () => { unreadable = false; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('translation button foreground contrast', () => {
  it.each([
    { rgb: [255, 255, 255], ink: 'dark', color: 'rgb(23 19 26)' },
    { rgb: [0, 0, 0], ink: 'light', color: 'rgb(255 255 255)' },
  ])('chooses $ink ink without changing the glass material', ({ rgb, ink, color }) => {
    const { button, properties, canvas, doc } = fixture(rgb);
    refreshButtonContrast(button);
    expect(button.dataset).toMatchObject({ ink, contrast: 'sampled' });
    expect([...properties.entries()]).toEqual([['--mt-glass-text', color]]);
    expect(button.dataset.tone).toBeUndefined();
    expect(canvas).toMatchObject({ width: 16, height: 6 });
    expect(doc.elementsFromPoint).toHaveBeenCalledTimes(3);
  });

  it('maps only the text/icon crop with cover/right positioning and the current image filter', () => {
    const { button, sourceStyle, context } = fixture([20, 20, 20]);
    sourceStyle.filter = 'brightness(.5) contrast(1.2)';
    refreshButtonContrast(button);
    expect(context.filter).toBe(sourceStyle.filter);
    const crop = context.drawImage.mock.calls[0];
    expect(crop.slice(1)).toEqual([775, 217.5, 54.6875, 50, 0, 0, 5, 6]);
    expect(context.drawImage).toHaveBeenCalledTimes(3);
  });

  it('uses the same small crop for an already rendered canvas', () => {
    const { button } = fixture([0, 0, 0], 'CANVAS');
    refreshButtonContrast(button);
    expect(button.dataset).toMatchObject({ ink: 'light', contrast: 'sampled' });
  });

  it('caches a tainted currentSrc without darkening the lens and retains the last readable ink', () => {
    const { button, source, unreadable, readable, context, properties } = fixture([255, 255, 255]);
    unreadable();
    refreshButtonContrast(button);
    expect(button.dataset).toMatchObject({ contrast: 'fallback' });
    expect(button.dataset.ink).toBeUndefined();
    expect(properties.size).toBe(0);
    expect(context.drawImage).toHaveBeenCalledOnce();
    refreshButtonContrast(button);
    expect(context.drawImage).toHaveBeenCalledOnce();
    source.currentSrc += '?replacement'; readable();
    refreshButtonContrast(button);
    expect(button.dataset).toMatchObject({ ink: 'dark', contrast: 'sampled' });
    expect(context.drawImage).toHaveBeenCalledTimes(4);
    source.currentSrc += '?tainted'; unreadable(); refreshButtonContrast(button);
    expect(button.dataset).toMatchObject({ ink: 'dark', contrast: 'fallback' });
    expect([...properties.entries()]).toEqual([['--mt-glass-text', 'rgb(23 19 26)']]);
  });

  it('leaves ordinary reading controls to their inherited theme', () => {
    const { button, doc, properties } = fixture([0, 0, 0]);
    vi.spyOn(button, 'closest').mockReturnValue(null);
    refreshButtonContrast(button);
    expect(properties.size).toBe(0);
    expect(doc.elementsFromPoint).not.toHaveBeenCalled();
  });

  it('keeps every glyph and icon on one ink across black hair and white bubbles, including exiting text', () => {
    const { button, glyphs, icon, label, properties, unreadable, context } = fixture([0, 0, 0], 'IMG', true);
    glyphs[0].dataset.torphExiting = '';
    for (const node of [...glyphs, icon, label]) {
      node.style.setProperty('color', 'rgb(23 19 26)'); node.dataset.ink = 'dark';
    }
    refreshButtonContrast(button);
    expect(button.dataset.contrast).toBe('sampled');
    expect(button.dataset.ink).toBe('balanced');
    const gray = properties.get('--mt-glass-text')!.match(/\d+/gu)!.map(Number);
    expect(gray[0]).toBeGreaterThan(110);
    expect(gray[0]).toBeLessThan(130);
    expect(gray).toEqual([gray[0], gray[0], gray[0]]);
    expect([...properties.keys()]).toEqual(['--mt-glass-text']);
    for (const node of [...glyphs, icon, label]) {
      expect(node.dataset.ink).toBeUndefined();
      expect(node.colors.has('color')).toBe(false);
    }
    expect(context.drawImage).toHaveBeenCalledTimes(3);
    const sampledInk = properties.get('--mt-glass-text');
    refreshButtonContrast(button);
    expect(properties.get('--mt-glass-text')).toBe(sampledInk);
    label.style.setProperty('color', 'rgb(23 19 26)'); label.dataset.ink = 'dark';
    unreadable(); refreshButtonContrast(button);
    expect(button.dataset.contrast).toBe('fallback');
    expect([...properties.entries()]).toEqual([['--mt-glass-text', sampledInk]]);
    for (const node of [...glyphs, icon, label]) {
      expect(node.dataset.ink).toBeUndefined();
      expect(node.colors.has('color')).toBe(false);
    }
  });

  it('ignores a small bright highlight on a predominantly dark image', () => {
    const { button } = fixture([20, 20, 20], 'IMG', true, 15);
    refreshButtonContrast(button);
    expect(button.dataset.ink).toBe('light');
  });

  it('retargets the unified neutral ink when a split backdrop changes substantially', () => {
    const rgb = [0, 0, 0];
    const { button, properties } = fixture(rgb, 'IMG', true);
    refreshButtonContrast(button);
    const before = Number(properties.get('--mt-glass-text')!.match(/\d+/u)![0]);
    rgb.fill(48); refreshButtonContrast(button);
    expect(button.dataset.ink).toBe('balanced');
    const after = Number(properties.get('--mt-glass-text')!.match(/\d+/u)![0]);
    expect(after).toBeGreaterThan(before + 10);
  });

  it('keeps ink stable around the crossover and switches when the backdrop meaningfully brightens', () => {
    const rgb = [110, 110, 110];
    const { button } = fixture(rgb);
    refreshButtonContrast(button);
    expect(button.dataset.ink).toBe('light');
    rgb.fill(116); refreshButtonContrast(button);
    expect(button.dataset.ink).toBe('light');
    rgb.fill(200); refreshButtonContrast(button);
    expect(button.dataset.ink).toBe('dark');
  });
});
