import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiquidGlass } from '../../../apps/extension/src/content/core/ui/liquidGlass';

class FixtureNode {
  children: FixtureNode[] = [];
  parent: FixtureNode | null = null;
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  className = '';
  id = '';
  isConnected = true;
  offsetWidth = 120;
  offsetHeight = 36;
  classList = { add: vi.fn() };
  style = {
    setProperty: (key: string, value: string) => this.properties.set(key, value),
    removeProperty: (key: string) => this.properties.delete(key),
  };
  constructor(public ownerDocument: FixtureDocument, public tagName: string) {}
  closest() { return null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); if (key === 'id') this.id = value; }
  prepend(...nodes: FixtureNode[]) { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  append(...nodes: FixtureNode[]) { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  replaceChildren(...nodes: FixtureNode[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  descendants(tagName: string): FixtureNode[] {
    return this.children.flatMap(node => [...(node.tagName === tagName ? [node] : []), ...node.descendants(tagName)]);
  }
}

class FixtureCanvas extends FixtureNode {
  width = 0;
  height = 0;
  getContext() {
    return {
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image: ImageData) => this.ownerDocument.imageWrites.push(image.data.slice()), drawImage: vi.fn(),
    };
  }
  toDataURL() { return 'data:image/png;base64,fixture'; }
}

class FixtureDocument extends EventTarget {
  hidden = false;
  URL = 'https://example.com/manga';
  media = Object.assign(new EventTarget(), { matches: false });
  frames = new Map<number, FrameRequestCallback>();
  nextFrame = 0;
  imageWrites: Uint8ClampedArray[] = [];
  defaultView = {
    navigator: { userAgent: 'Chrome/150' }, devicePixelRatio: 1,
    matchMedia: () => this.media,
    requestAnimationFrame: (callback: FrameRequestCallback) => { this.frames.set(++this.nextFrame, callback); return this.nextFrame; },
    cancelAnimationFrame: (id: number) => this.frames.delete(id),
  };
  createElement(tagName: string) { return tagName === 'canvas' ? new FixtureCanvas(this, tagName) : new FixtureNode(this, tagName); }
  createElementNS(_ns: string, tagName: string) { return new FixtureNode(this, tagName); }
  frame(now: number) {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(now);
  }
}

function fixture() {
  const doc = new FixtureDocument();
  const button = doc.createElement('button');
  let resizeCallback: (() => void) | undefined;
  let intersectionCallback: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  const resizeDisconnect = vi.fn(), intersectionDisconnect = vi.fn();
  vi.stubGlobal('CSS', { supports: () => true });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe() {} disconnect = resizeDisconnect;
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersectionCallback = callback; }
    observe() {} disconnect = intersectionDisconnect;
  });
  return { doc, button, resize: () => resizeCallback!(), intersect: (visible: boolean) => intersectionCallback!([{ isIntersecting: visible }]), resizeDisconnect, intersectionDisconnect };
}

afterEach(() => vi.unstubAllGlobals());

describe('translation button liquid glass', () => {
  it('keeps fixed caps and unique, document-local filters as the button shrinks', () => {
    const { button, resize, doc } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const filter = button.descendants('filter')[0];
    expect(filter.attributes.get('width')).toBe('174');
    const images = button.descendants('feImage');
    expect(images).toHaveLength(15);
    expect(images.slice(0, 3).map(node => node.attributes.get('width'))).toEqual(['18', '84', '18']);
    expect(button.descendants('feGaussianBlur')[0].attributes.get('stdDeviation')).toBe('0.95');
    expect(button.descendants('feDisplacementMap').every(node => node.attributes.get('scale') === '48')).toBe(true);
    const rim = doc.imageWrites[1];
    const alpha = (x: number, y: number) => rim[(y * 38 + x) * 4 + 3];
    expect(alpha(19, 18)).toBe(0);
    expect(alpha(19, 0)).toBe(43); // Reference top normal: .45 * .5 * (1 - .5²), encoded to 255.
    expect(alpha(19, 35)).toBeGreaterThan(0);
    expect(alpha(19, 0)).toBe(alpha(19, 35)); // The source's opposite light is equally strong, with no dark-side overlay.
    expect(Array.from(rim).every((value, index) => index % 4 === 3 || value === 0 || value === 255)).toBe(true);
    const material = glass.material as unknown as FixtureNode;
    expect(material.className).toBe('mt-x-glass-material mt-x-glass-refracted');
    expect(material.properties.has('background-image')).toBe(false);
    expect(button.descendants('feBlend').map(node => node.attributes.get('result'))).toEqual(['rg', 'rgb']);
    const specular = button.descendants('feComposite').at(-1)!;
    expect(Object.fromEntries(specular.attributes)).toMatchObject({ in: 'glass-with-reflection', in2: 'rim', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0' });
    expect(filter.attributes.get('color-interpolation-filters')).toBe('sRGB');
    // Encoded Snell channels remain inside their range; the PNG has not clipped a physical ray.
    for (const displacement of [doc.imageWrites[0], doc.imageWrites[3], doc.imageWrites[6]]) {
      expect(Array.from(displacement).every((value, index) => index % 4 > 1 || (value > 0 && value < 255))).toBe(true);
    }
    const reflection = doc.imageWrites[2];
    expect(reflection[(0 * 38 + 19) * 4 + 1]).toBe(32);
    expect(reflection[(35 * 38 + 19) * 4 + 1]).toBe(223); // Opposite normals sample 18px outward on each side.
    const transfers = button.descendants('feComponentTransfer');
    const presence = transfers.find(node => node.attributes.get('result') === 'reflection-presence')!;
    const acceptance = transfers.find(node => node.attributes.get('result') === 'reflection-acceptance')!;
    const values = (node: FixtureNode) => node.children[0].attributes.get('tableValues')!.split(' ').map(Number);
    const p = values(presence), a = values(acceptance);
    expect(p).toHaveLength(33); expect(a).toHaveLength(33);
    expect(p.slice(0, 7).every(value => value === 0)).toBe(true);
    expect(p.slice(28).every(value => value === 1)).toBe(true);
    expect(a.slice(0, 12).every(value => value === 1)).toBe(true);
    expect(a.slice(28).every(value => value === 0)).toBe(true);
    expect(p.every((value, index) => !index || value >= p[index - 1])).toBe(true);
    expect(a.every((value, index) => !index || value <= a[index - 1])).toBe(true);
    const composites = button.descendants('feComposite');
    expect(Object.fromEntries(composites.find(node => node.attributes.get('result') === 'reflection-gate')!.attributes))
      .toMatchObject({ in: 'reflection-presence', in2: 'reflection-acceptance', operator: 'in' });
    expect(Object.fromEntries(composites.find(node => node.attributes.get('result') === 'glass-with-reflection')!.attributes))
      .toMatchObject({ in: 'coloured-rim', in2: 'interior', operator: 'over' });
    expect(button.descendants('feFlood')[0].properties.get('flood-color')).toBe('var(--mt-glass-tint,#fff8fc0d)');
    button.offsetWidth = 72;
    resize();
    expect(images.slice(0, 3).map(node => node.attributes.get('width'))).toEqual(['18', '36', '18']);
    expect(images[2].attributes.get('x')).toBe('54');
    const other = doc.createElement('button');
    const second = createLiquidGlass(other as unknown as HTMLButtonElement);
    expect(other.descendants('filter')[0].id).not.toBe(filter.id);
    expect((glass.material as unknown as FixtureNode).properties.get('backdrop-filter')).toBe(`url("https://example.com/manga#${filter.id}")`);
    glass.destroy(); second.destroy();
    expect(button.descendants('filter')).toHaveLength(0);
  });

  it('runs the pink light only while connected, visible and busy, and releases resources', () => {
    const { button, doc, intersect, resizeDisconnect, intersectionDisconnect } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const material = glass.material as unknown as FixtureNode;
    expect(doc.frames.size).toBe(0);
    glass.setRunning(true);
    expect(doc.frames.size).toBe(1);
    expect(material.properties.get('--activity-light')).toBe('.88');
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    expect(doc.frames.size).toBe(0);
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    expect(doc.frames.size).toBe(1);
    intersect(false); expect(doc.frames.size).toBe(0);
    intersect(true); expect(doc.frames.size).toBe(1);
    doc.media.matches = true; doc.media.dispatchEvent(new Event('change'));
    // The requested effect is independent of the system reduced-motion preference.
    expect(doc.frames.size).toBe(1);
    button.isConnected = false; doc.frame(1000);
    expect(doc.frames.size).toBe(0);
    button.isConnected = true; glass.refresh(); expect(doc.frames.size).toBe(1);
    glass.setRunning(false); expect(doc.frames.size).toBe(0);
    glass.setRunning(true); glass.destroy(); glass.destroy();
    expect(doc.frames.size).toBe(0);
    expect(resizeDisconnect).toHaveBeenCalledTimes(1);
    expect(intersectionDisconnect).toHaveBeenCalledTimes(1);
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.media.dispatchEvent(new Event('change'));
    expect(doc.frames.size).toBe(0);
    expect(button.children).toHaveLength(0);
  });

  it('has a continuous loop with a pronounced change in angular speed', () => {
    const { doc, button } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const material = glass.material as unknown as FixtureNode;
    glass.setRunning(true);
    const pose = (now: number) => {
      doc.frame(now);
      return ['--flow-x', '--flow-y'].map(key => parseFloat(material.properties.get(key)!));
    };
    const start = pose(0), end = pose(3200);
    expect(end).toEqual(start);
    const slow = pose(1), fastA = pose(1600), fastB = pose(1601);
    const speed = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    expect(speed(fastA, fastB) / speed(start, slow)).toBeGreaterThan(7);
    const before = pose(3199), after = pose(3201);
    expect(speed(before, start)).toBeCloseTo(speed(start, after), 3);
    glass.destroy();
  });

  it('leaves the uniform CSS frost fallback intact on unsupported browsers or without canvas', () => {
    const { doc, button } = fixture();
    doc.defaultView.navigator.userAgent = 'Firefox/150';
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    expect(button.descendants('filter')).toHaveLength(0);
    expect((glass.material as unknown as FixtureNode).properties.has('backdrop-filter')).toBe(false);
    glass.destroy();
    doc.defaultView.navigator.userAgent = 'Chrome/150';
    button.offsetHeight = 37; // Avoid a cached optical map when testing unavailable canvas.
    vi.spyOn(FixtureCanvas.prototype, 'getContext').mockReturnValue(null as unknown as ReturnType<FixtureCanvas['getContext']>);
    const noCanvas = createLiquidGlass(button as unknown as HTMLButtonElement);
    expect(button.descendants('filter')).toHaveLength(0);
    expect((noCanvas.material as unknown as FixtureNode).properties.has('backdrop-filter')).toBe(false);
    noCanvas.destroy(); vi.restoreAllMocks();
  });
});
