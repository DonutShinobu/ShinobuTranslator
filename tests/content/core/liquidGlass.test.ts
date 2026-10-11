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
  it('ports Clear optics and a padded 45-degree overlay without stretching narrow caps', () => {
    const { button, resize, doc } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const filter = button.descendants('filter')[0];
    expect(filter.attributes.get('width')).toBe('244');
    expect(filter.attributes.get('x')).toBe('-62');
    const images = filter.descendants('feImage');
    expect(images).toHaveLength(3);
    expect(images.map(node => node.attributes.get('width'))).toEqual(['38', '49', '38']);
    expect(images.map(node => node.attributes.get('x'))).toEqual(['-2', '35.5', '84']);
    expect(button.descendants('feGaussianBlur')).toHaveLength(0);
    expect(filter.descendants('feFlood')).toHaveLength(0);
    expect(Object.fromEntries(button.descendants('feDisplacementMap')[0].attributes))
      .toMatchObject({ in: 'SourceGraphic', in2: 'field', scale: '120', xChannelSelector: 'R', yChannelSelector: 'G' });
    const [field, shade, normal, diffuse] = doc.imageWrites;
    const pixel = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.slice((y * 112 + x) * 4, (y * 112 + x + 1) * 4));
    // 0.5px inside the top edge, source depth=.025: E=1-sqrt(1.975*.025); no 24px clipping.
    expect(pixel(field, 56, 2)).toEqual([128, 227, 128, 255]);
    expect(pixel(field, 56, 37)).toEqual([128, 28, 128, 255]);
    expect(pixel(field, 56, 0)).toEqual([128, 255, 128, 255]);
    const outerSide = pixel(shade, 105, 7);
    expect(outerSide.slice(0, 3)).toEqual([0, 0, 0]);
    expect(outerSide[3]).toBeGreaterThan(20); // The source's outer black rim survives outside the round clip.
    expect(pixel(normal, 56, 20)[2]).toBe(0);
    expect(pixel(diffuse, 56, 20)).toEqual([0, 0, 0, 255]); // Opaque profile slices stay seam-free; R decodes into zero centre alpha.
    expect(pixel(diffuse, 56, 2)).toEqual([36, 36, 36, 255]);
    const profileDecode = button.descendants('feColorMatrix').find(node => node.attributes.get('result') === 'diffuse-profile')!;
    expect(profileDecode.attributes.get('in')).toBe('diffuse-rgb');
    expect(profileDecode.attributes.get('values')!.split(' ').map(Number).slice(15)).toEqual([1, 0, 0, 0, 0]);
    expect(pixel(normal, 56, 2)).toEqual([128, 0, 230, 255]);
    const rimOverlay = button.descendants('svg').find(node => node.attributes.get('class') === 'mt-x-glass-overlay')!;
    const keyLight = button.descendants('g').find(node => node.attributes.get('class') === 'mt-x-glass-activity')!;
    const overlayImages = keyLight.children.filter(node => node.tagName === 'image');
    expect(overlayImages).toHaveLength(3);
    expect(overlayImages.map(node => node.attributes.get('x'))).toEqual(['37.5', '0', '86']);
    expect(rimOverlay.attributes.get('viewBox')).toBe('0 0 124 40');
    const material = glass.material as unknown as FixtureNode;
    expect(material.className).toBe('mt-x-glass-material mt-x-glass-optical mt-x-glass-refracted');
    expect(material.properties.has('background-image')).toBe(false);
    expect(filter.descendants('feBlend')).toHaveLength(0);
    expect(filter.descendants('feComposite')).toHaveLength(0); // Native padded SVG supplies the source's overlay-over operation once.
    expect(filter.attributes.get('color-interpolation-filters')).toBe('sRGB');
    const transfer = filter.descendants('feComponentTransfer')[0];
    expect(Object.fromEntries(transfer.attributes)).toMatchObject({ in: 'refracted', result: 'clear-tone' });
    expect(transfer.children.map(node => node.tagName)).toEqual(['feFuncR', 'feFuncG', 'feFuncB']);
    const tables = transfer.children.map(node => node.attributes.get('tableValues')!);
    expect(new Set(tables).size).toBe(1);
    const table = tables[0].split(' ').map(Number);
    expect(table).toHaveLength(33);
    expect([table[0], table[16], table[32]]).toEqual([.1848, .53015, 1]);
    expect(table.every((value, index) => !index || value >= table[index - 1])).toBe(true);
    button.offsetWidth = 72;
    resize();
    expect(images.map(node => node.attributes.get('width'))).toEqual(['38', '1', '38']);
    expect(images[2].attributes.get('x')).toBe('36');
    expect(doc.imageWrites).toHaveLength(4); // Normal label widths share the fixed canonical cap maps.
    button.offsetWidth = 44;
    resize();
    expect(button.descendants('filter')[0].descendants('feImage')).toHaveLength(1);
    expect(button.descendants('filter')[0].descendants('feImage')[0].attributes.get('width')).toBe('48');
    const narrowOverlay = button.descendants('svg').find(node => node.attributes.get('class') === 'mt-x-glass-overlay')!;
    expect(narrowOverlay.children.filter(node => node.tagName === 'image')).toHaveLength(1);
    expect(narrowOverlay.attributes.get('viewBox')).toBe('0 0 48 40');
    expect(doc.imageWrites[4]).toHaveLength(48 * 40 * 4); // Rebuild exact narrow geometry rather than shrinking a 3H map.
    button.offsetWidth = 240;
    resize();
    expect(button.descendants('filter')[0].descendants('feImage').map(node => node.attributes.get('width'))).toEqual(['38', '169', '38']);
    expect(doc.imageWrites).toHaveLength(8);
    const currentFilter = button.descendants('filter')[0];
    const other = doc.createElement('button');
    const second = createLiquidGlass(other as unknown as HTMLButtonElement);
    expect(other.descendants('filter')[0].id).not.toBe(currentFilter.id);
    expect(material.properties.get('backdrop-filter')).toBe(`url("https://example.com/manga#${currentFilter.id}")`);
    doc.URL = 'https://example.com/next#section'; glass.refresh();
    expect(material.properties.get('backdrop-filter')).toBe(`url("https://example.com/next#${currentFilter.id}")`);
    glass.destroy(); second.destroy();
    expect(button.descendants('filter')).toHaveLength(0);
  });

  it('runs the pink light only while connected, visible and busy, and releases resources', () => {
    const { button, doc, intersect, resizeDisconnect, intersectionDisconnect } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const lightColor = button.descendants('feFlood')[0];
    expect(doc.frames.size).toBe(0);
    glass.setRunning(true);
    expect(doc.frames.size).toBe(1);
    expect(lightColor.properties.get('flood-color')).toBe('#f18dc6');
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

  it('moves paired local peaks without relighting the entire straight edge', () => {
    const { doc, button } = fixture();
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    const projection = () => button.descendants('feColorMatrix').find(node => node.attributes.get('data-glass-light') === 'pink')!;
    const keyLightImages = () => button.descendants('g').find(node => node.attributes.get('class') === 'mt-x-glass-activity')!
      .children.filter(node => node.tagName === 'image').map(node => node.attributes.get('href'));
    const staticRim = keyLightImages();
    const imageWrites = doc.imageWrites.length;
    const headOf = () => button.descendants('circle').find(node => node.attributes.get('data-glass-light') === 'head')!;
    const headMatrix = () => headOf().attributes.get('transform')!.match(/-?[\d.]+/gu)!.map(Number);
    const oppositeMatrix = () => button.descendants('circle').find(node => node.attributes.get('data-glass-light') === 'opposite-head')!
      .attributes.get('transform')!.match(/-?[\d.]+/gu)!.map(Number);
    glass.setRunning(true);
    const pose = (now: number) => {
      doc.frame(now);
      return headMatrix().slice(4, 6);
    };
    const start = pose(0), end = pose(2800);
    expect(end).toEqual(start);
    expect(projection().attributes.get('values')!.split(' ').map(Number).slice(15, 17)).toEqual([-.707107, -.707107]);
    const slow = pose(1), fastA = pose(700), fastB = pose(701);
    const speed = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    expect(speed(fastA, fastB) / speed(start, slow)).toBeGreaterThan(10);
    const oppositeStart = oppositeMatrix().slice(4, 6);
    expect(pose(2101)).toEqual(oppositeStart); // Both opposite peaks share the half-turn rhythm.
    const before = pose(2799), after = pose(2801);
    expect(speed(before, start)).toBeCloseTo(speed(start, after), 3);
    const base = () => button.descendants('rect').find(node => node.attributes.get('class') === 'mt-x-glass-light-base')!;
    expect(base().properties.get('opacity')).toBe('0'); // No full-edge base can obscure the travelling peaks while busy.
    const directionTables = button.descendants('feComponentTransfer').filter(node => ['specular-direction', 'diffuse-direction'].includes(node.attributes.get('result') || ''))
      .map(node => node.children[0].attributes.get('tableValues')!.split(' ').map(Number));
    expect(directionTables).toHaveLength(2);
    for (const [index, table] of directionTables.entries()) {
      const spread = index ? .702 : 1.08;
      expect(table).toEqual(Array.from({ length: 257 }, (_, i) => Number(Math.pow(Math.max(0, Math.min(1,
        (Math.abs(2 * i / 256 - 1) - Math.cos(spread)) / (1 - Math.cos(spread)))), 1.25).toFixed(6))));
    }
    expect(doc.imageWrites).toHaveLength(imageWrites); // Only GPU projection coefficients change each frame.
    expect(keyLightImages()).toEqual(staticRim);
    pose(800);
    const beforeResize = headOf().attributes.get('transform');
    button.offsetWidth = 44;
    glass.refresh();
    expect(headMatrix().every(Number.isFinite)).toBe(true);
    button.offsetWidth = 120; glass.refresh();
    expect(headOf().attributes.get('transform')).toBe(beforeResize);
    button.offsetWidth = 310;
    glass.refresh();
    const straightA = pose(600), directionA = projection().attributes.get('values');
    const straightB = pose(800), directionB = projection().attributes.get('values');
    expect(straightA[1]).toBe(2); expect(straightB[1]).toBe(2);
    expect(straightB[0] - straightA[0]).toBeGreaterThan(20);
    expect(directionB).toBe(directionA);
    const opposite = oppositeMatrix();
    expect(straightB[0] + opposite[4]).toBeCloseTo(314, 3);
    expect(straightB[1] + opposite[5]).toBeCloseTo(40, 3);
    expect(Math.hypot(...headMatrix().slice(0, 2))).toBeGreaterThan(36 * .65); // Peaks lengthen in the fast portion.
    const movingPose = headOf().attributes.get('transform');
    glass.setRunning(true);
    expect(headOf().attributes.get('transform')).toBe(movingPose); // Stage updates cannot restart the light.
    glass.setRunning(false); glass.setRunning(true);
    expect(headOf().attributes.get('transform')).toBe(movingPose); // A new job interrupts settling at its current position.
    glass.setRunning(false);
    expect(base().properties.get('opacity')).toBe('0');
    expect(button.descendants('feFlood')[0].properties.get('flood-color')).toBe('#fff');
    doc.frame(900); doc.frame(1300);
    expect(base().properties.get('opacity')).toBe('1');
    expect(doc.frames.size).toBe(0);
    glass.setRunning(true);
    button.offsetWidth = 0;
    glass.refresh();
    expect(doc.frames.size).toBe(0);
    button.offsetWidth = 310; glass.refresh();
    expect(doc.frames.size).toBe(1);
    glass.destroy();
  });

  it('settles forward without a position jump, preserving pause, resize and interruption', () => {
    for (const stopAt of [49, 700, 1395, 1800]) {
      const { doc, button, intersect } = fixture();
      const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
      const head = () => button.descendants('circle').find(node => node.attributes.get('data-glass-light') === 'head')!;
      const pose = () => head().attributes.get('transform');
      const point = () => pose()!.match(/-?[\d.]+/gu)!.map(Number).slice(4, 6);
      const step = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const base = () => button.descendants('rect').find(node => node.attributes.get('class') === 'mt-x-glass-light-base')!;
      glass.setRunning(true); doc.frame(0); doc.frame(stopAt - 1);
      const incoming = point(); doc.frame(stopAt);
      const moving = pose();
      const stoppedPoint = point();
      glass.setRunning(false);
      expect(pose()).toBe(moving);
      expect(base().properties.get('opacity')).toBe('0');
      doc.frame(stopAt); doc.frame(stopAt + 1);
      expect(pose()).not.toBe(moving);
      expect(step(stoppedPoint, point()) / step(incoming, stoppedPoint)).toBeGreaterThan(.75);
      expect(step(stoppedPoint, point()) / step(incoming, stoppedPoint)).toBeLessThan(1.25);
      const settlingPose = pose();
      glass.setRunning(false); expect(pose()).toBe(settlingPose);
      button.offsetWidth = 44; glass.refresh();
      expect(base().attributes.get('opacity')).toBe('0'); // Narrow map rebuilds must not relight the full straight edge.
      button.offsetWidth = 120; glass.refresh();
      expect(pose()).toBe(settlingPose);
      intersect(false); expect(doc.frames.size).toBe(0);
      intersect(true); doc.frame(stopAt + 5000);
      expect(pose()).toBe(settlingPose); // Hidden time does not advance the return.
      glass.setRunning(true); expect(pose()).toBe(settlingPose);
      doc.frame(stopAt + 5010); expect(pose()).toBe(settlingPose);
      doc.frame(stopAt + 5011);
      glass.setRunning(false); doc.frame(stopAt + 5011); doc.frame(stopAt + 5500);
      expect(base().properties.get('opacity')).toBe('1');
      const direction = button.descendants('feColorMatrix').find(node => node.attributes.get('data-glass-light') === 'pink')!
        .attributes.get('values')!.split(' ').map(Number).slice(15, 17);
      expect(direction.map(Math.abs)).toEqual([.707107, .707107]);
      const resting = pose(); doc.frame(stopAt + 6000);
      expect(pose()).toBe(resting); expect(doc.frames.size).toBe(0);
      glass.setRunning(true); doc.frame(stopAt + 6000); doc.frame(stopAt + 6100);
      glass.setRunning(false); glass.destroy();
      expect(doc.frames.size).toBe(0);
    }
  });

  it('keeps edge light without Chromium refraction and tolerates unavailable canvas', () => {
    const { doc, button } = fixture();
    doc.defaultView.navigator.userAgent = 'Firefox/150';
    const glass = createLiquidGlass(button as unknown as HTMLButtonElement);
    expect(button.descendants('feDisplacementMap')).toHaveLength(0);
    expect(button.descendants('feColorMatrix').some(node => node.attributes.get('data-glass-light') === 'pink')).toBe(true);
    expect((glass.material as unknown as FixtureNode).className).toBe('mt-x-glass-material mt-x-glass-optical');
    expect((glass.material as unknown as FixtureNode).properties.has('backdrop-filter')).toBe(false);
    glass.destroy();
    doc.defaultView.navigator.userAgent = 'Chrome/150';
    button.offsetHeight = 37; // Avoid a cached optical map when testing unavailable canvas.
    vi.spyOn(FixtureCanvas.prototype, 'getContext').mockReturnValue(null as unknown as ReturnType<FixtureCanvas['getContext']>);
    const noCanvas = createLiquidGlass(button as unknown as HTMLButtonElement);
    expect(button.descendants('filter')).toHaveLength(0);
    expect((noCanvas.material as unknown as FixtureNode).properties.has('backdrop-filter')).toBe(false);
    noCanvas.setRunning(true);
    expect(doc.frames.size).toBe(0);
    noCanvas.destroy(); vi.restoreAllMocks();
  });
});
