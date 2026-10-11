import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlassInteraction } from '../../../apps/extension/src/content/core/ui/glassInteraction';

class FixtureView extends EventTarget {
  frames = new Map<number, FrameRequestCallback>();
  nextFrame = 0;
  fine = true;
  matchMedia = vi.fn(() => ({ matches: this.fine }));
  requestAnimationFrame(callback: FrameRequestCallback) { this.frames.set(++this.nextFrame, callback); return this.nextFrame; }
  cancelAnimationFrame(id: number) { this.frames.delete(id); }
  frame(now: number) {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(now);
  }
}

class FixtureDocument extends EventTarget {
  hidden = false;
  defaultView = new FixtureView();
}

class FixtureButton extends EventTarget {
  ownerDocument = new FixtureDocument();
  isConnected = true;
  disabled = false;
  ariaDisabled = false;
  offsetWidth = 72;
  offsetHeight = 36;
  nodeType = 1;
  dataset: Record<string, string> = {};
  values = new Map<string, string>();
  style = {
    getPropertyValue: (name: string) => this.values.get(name) || '',
    setProperty: (name: string, value: string) => this.values.set(name, value),
    removeProperty: (name: string) => this.values.delete(name),
    get translate() { return this.getPropertyValue('translate'); },
    set translate(value: string) { this.setProperty('translate', value); },
    get scale() { return this.getPropertyValue('scale'); },
    set scale(value: string) { this.setProperty('scale', value); },
  };
  matches() { return this.disabled || this.ariaDisabled || this.dataset.disabled !== undefined; }
  closest() { return null; }
  getBoundingClientRect() {
    const [tx = 0, ty = 0] = this.style.translate.split(' ').map(value => parseFloat(value) || 0);
    const [sx = 1, sy = sx] = this.style.scale.split(' ').map(value => parseFloat(value) || 1);
    const width = this.offsetWidth * sx, height = this.offsetHeight * sy;
    return { left: 100 + (this.offsetWidth - width) / 2 + tx, top: 200 + (this.offsetHeight - height) / 2 + ty, width, height };
  }
}

function pointer(target: EventTarget, type: string, x = 136, y = 218, id = 1, pointerType = 'touch', button = 0) {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: id, clientX: x, clientY: y, pointerType, button });
  target.dispatchEvent(event);
  return event;
}

function key(target: EventTarget, type: string, value = ' ', repeat = false) {
  const event = Object.assign(new Event(type, { cancelable: true }), { key: value, repeat });
  target.dispatchEvent(event);
  return event;
}

function fixture(width = 72) {
  const button = new FixtureButton();
  button.offsetWidth = width;
  const doc = button.ownerDocument, view = doc.defaultView;
  let mutation: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {} disconnect = disconnect;
  });
  const interaction = createGlassInteraction(button as unknown as HTMLButtonElement);
  const scale = () => button.style.scale ? button.style.scale.split(' ').map(Number) : [1, 1];
  const settle = (from: number) => { for (let now = from; now <= from + 2500; now += 16) view.frame(now); };
  return { button, doc, view, interaction, scale, settle, mutate: () => mutation!(), disconnect };
}

afterEach(() => vi.unstubAllGlobals());

describe('Glass-HQ button interaction', () => {
  it('grows under a hold and overshoots on release, including clicks that disable before the first paint', () => {
    const { button, view, interaction, scale, settle } = fixture();
    expect(view.frames.size).toBe(0);
    expect(pointer(button, 'pointerdown').defaultPrevented).toBe(false);
    view.frame(16); view.frame(1500);
    expect(scale()).toEqual([1.11111, 1.11111]); // Source grow=8/72; ordinary buttons grow instead of shrinking.
    expect(button.style.getPropertyValue('--lg-glow')).toBe('1.0000');
    pointer(view, 'pointerup');
    const poses: number[] = [];
    for (let now = 1516; now <= 3500; now += 16) { view.frame(now); poses.push(scale()[0]); }
    expect(Math.min(...poses)).toBeLessThan(.995);
    expect(scale()).toEqual([1, 1]);
    expect(view.frames.size).toBe(0);

    const click = vi.fn(() => { button.disabled = true; interaction.refresh(); });
    button.addEventListener('click', click);
    pointer(button, 'pointerdown'); pointer(view, 'pointerup');
    button.dispatchEvent(new Event('click'));
    expect(click).toHaveBeenCalledTimes(1); // No timer defers the translation action.
    expect(button.dataset.glassPressed).toBeUndefined();
    view.frame(3600);
    expect(scale()[0]).toBeGreaterThan(1.005);
    expect(parseFloat(button.style.getPropertyValue('--lg-glow'))).toBeGreaterThan(.1);
    pointer(button, 'pointerdown'); // Disabled input cannot start another hold.
    expect(button.dataset.glassPressed).toBeUndefined();
    settle(3616);
    expect(scale()).toEqual([1, 1]); expect(view.frames.size).toBe(0);
    interaction.destroy();
  });

  it('uses bounded drag resistance, anisotropic stretch, matching pointer ids and native cancellation', () => {
    const { button, view, interaction, scale, settle } = fixture();
    pointer(button, 'pointerdown');
    view.frame(16);
    pointer(button, 'pointerdown', 800, 800, 2);
    pointer(view, 'pointermove', 336, 218);
    view.frame(32); view.frame(1200);
    const [tx, ty] = button.style.translate.split(' ').map(parseFloat);
    expect(tx).toBeGreaterThan(10); expect(tx).toBeLessThan(14.8); expect(ty).toBe(0);
    expect(scale()[0]).toBeGreaterThan(scale()[1]);
    pointer(view, 'pointerup', 336, 218, 2);
    expect(button.dataset.glassPressed).toBe('');
    const up = pointer(view, 'pointercancel', 336, 218);
    expect(up.defaultPrevented).toBe(false);
    expect(button.dataset.glassPressed).toBeUndefined();
    settle(1216); expect(button.style.translate).toBe(''); expect(view.frames.size).toBe(0);
    button.offsetWidth = 180;
    pointer(button, 'pointerdown', 150, 218);
    pointer(view, 'pointermove', 200, 218);
    view.frame(4000); view.frame(5000);
    expect(button.style.translate).toBe(''); // Large surfaces resist only beyond their live edges.
    view.dispatchEvent(new Event('blur'));
    settle(5016); expect(view.frames.size).toBe(0);
    interaction.destroy();
  });

  it('preserves native Enter and Space, rejects repeats/disabled input and releases on lost focus', () => {
    const { button, view, interaction, scale, mutate, settle } = fixture();
    expect(key(button, 'keydown', 'Enter').defaultPrevented).toBe(false);
    key(button, 'keydown', 'Enter', true);
    view.frame(16); view.frame(800);
    expect(scale()[0]).toBeCloseTo(1.11111, 5);
    expect(button.style.getPropertyValue('--lg-glow-x')).toBe('36.00px');
    expect(button.style.getPropertyValue('--lg-glow-y')).toBe('18.00px');
    expect(key(button, 'keyup', 'Enter').defaultPrevented).toBe(false);
    button.disabled = true; mutate();
    view.frame(816);
    expect(scale()[0]).toBeGreaterThan(1.05); // Disabled after activation keeps the release's velocity.
    settle(832);
    key(button, 'keydown'); expect(button.dataset.glassPressed).toBeUndefined();
    button.disabled = false; button.ariaDisabled = true;
    key(button, 'keydown'); expect(button.dataset.glassPressed).toBeUndefined();
    button.ariaDisabled = false;
    key(button, 'keydown'); view.frame(4000);
    button.dispatchEvent(new Event('focusout'));
    settle(4016); expect(view.frames.size).toBe(0);
    expect(button.style.scale).toBe('');
    interaction.destroy();
  });

  it('settles the source hover light without idle frames and keeps touch input out of hover', () => {
    const { button, view, interaction, settle } = fixture(120);
    pointer(button, 'pointerenter', 130, 215, 1, 'mouse');
    settle(16);
    expect(button.style.getPropertyValue('--lg-glow')).toBe('0.3500');
    expect(button.style.getPropertyValue('--lg-glow-x')).toBe('30.00px');
    expect(button.style.getPropertyValue('--lg-glow-y')).toBe('15.00px');
    expect(button.style.getPropertyValue('--lg-glow-size')).toBe('108.0px');
    expect(button.style.scale).toBe(''); expect(view.frames.size).toBe(0);
    expect(view.matchMedia).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
    pointer(button, 'pointerleave', 130, 215, 1, 'mouse'); settle(2600);
    expect(button.style.getPropertyValue('--lg-glow')).toBe('');
    pointer(button, 'pointerenter'); expect(view.frames.size).toBe(0);
    interaction.destroy();
  });

  it('pauses hidden/offscreen/detached controls and destroys listeners, observers and owned styles', () => {
    const { button, doc, view, interaction, settle, disconnect } = fixture();
    pointer(button, 'pointerdown'); view.frame(16);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    expect(view.frames.size).toBe(0); expect(button.dataset.glassPressed).toBeUndefined();
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    expect(view.frames.size).toBe(1); settle(32); expect(view.frames.size).toBe(0);
    pointer(button, 'pointerdown'); view.frame(3000);
    interaction.setVisible(false); expect(view.frames.size).toBe(0);
    interaction.setVisible(true); settle(3016); expect(view.frames.size).toBe(0);
    pointer(button, 'pointerdown'); view.frame(6000);
    button.isConnected = false; view.frame(6016); expect(view.frames.size).toBe(0);
    button.isConnected = true; interaction.refresh(); settle(6032); expect(view.frames.size).toBe(0);
    pointer(button, 'pointerdown'); interaction.destroy(); interaction.destroy();
    expect(view.frames.size).toBe(0); expect(disconnect).toHaveBeenCalledTimes(1);
    pointer(button, 'pointerdown'); key(button, 'keydown');
    doc.dispatchEvent(new Event('visibilitychange')); view.dispatchEvent(new Event('blur'));
    expect(view.frames.size).toBe(0); expect(button.style.scale).toBe(''); expect(button.style.translate).toBe('');
    expect([...button.values.keys()].some(name => name.startsWith('--lg-glow'))).toBe(false);
  });
});
