/*!
 * Press springs, rubber-band drag, constant-volume stretch and local glow adapted from:
 * https://github.com/Glass-HQ/liquid-glass/blob/9f5bfc7daa7be5d20a41b94d841b8f065de655fc/packages/liquid-glass/src/core/spring.ts
 * https://github.com/Glass-HQ/liquid-glass/blob/9f5bfc7daa7be5d20a41b94d841b8f065de655fc/packages/liquid-glass/src/dom/interaction.ts
 * Standalone port wakes on input and sleeps at rest; hidden controls pause without resetting spring velocity.
 *
 * MIT License — Copyright (c) 2026 Glass HQ
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type SpringOptions = { duration: number; bounce: number };
const springs = {
  press: { duration: .24, bounce: .2 },
  release: { duration: .5, bounce: .42 },
  glow: { duration: .42, bounce: 0 },
  track: { duration: .18, bounce: 0 },
};

class Spring {
  velocity = 0;
  target: number;
  private stiffness = 0;
  private damping = 0;
  constructor(public value: number, options: SpringOptions) {
    this.target = value;
    this.configure(options);
  }
  configure({ duration, bounce }: SpringOptions): this {
    if (!(duration > 0) || !Number.isFinite(duration)) throw new RangeError('Spring duration must be positive and finite.');
    if (!(bounce > -1 && bounce < 1)) throw new RangeError('Spring bounce must be greater than -1 and less than 1.');
    const omega = 2 * Math.PI / duration;
    this.stiffness = omega * omega;
    this.damping = bounce >= 0 ? 4 * Math.PI * (1 - bounce) / duration : 4 * Math.PI / (duration * (1 + bounce));
    return this;
  }
  get settled() { return this.value === this.target && this.velocity === 0; }
  step(dt: number) {
    if (this.settled || !(dt > 0)) return;
    const omega = Math.sqrt(this.stiffness), zeta = this.damping / (2 * omega);
    const x0 = this.value - this.target, v0 = this.velocity;
    let x: number, v: number;
    if (zeta < 1) {
      const wd = omega * Math.sqrt(1 - zeta * zeta), decay = Math.exp(-zeta * omega * dt);
      const a = x0, b = (v0 + zeta * omega * x0) / wd;
      const cos = Math.cos(wd * dt), sin = Math.sin(wd * dt);
      x = decay * (a * cos + b * sin);
      v = decay * ((b * wd - zeta * omega * a) * cos - (a * wd + zeta * omega * b) * sin);
    } else if (zeta === 1) {
      const decay = Math.exp(-omega * dt), b = v0 + omega * x0;
      x = decay * (x0 + b * dt);
      v = decay * (b - omega * (x0 + b * dt));
    } else {
      const root = omega * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * omega + root, r2 = -zeta * omega - root;
      const c2 = (v0 - r1 * x0) / (r2 - r1), c1 = x0 - c2;
      const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
      x = c1 * e1 + c2 * e2;
      v = c1 * r1 * e1 + c2 * r2 * e2;
    }
    const scale = Math.max(1, Math.abs(this.target), Math.abs(x0));
    if (Math.abs(x) < 1e-4 * scale && Math.abs(v) < 1e-3 * scale) {
      this.value = this.target;
      this.velocity = 0;
    } else {
      this.value = this.target + x;
      this.velocity = v;
    }
  }
}

const claimed = new WeakSet<Event>();
const glowProperties = ['--lg-glow', '--lg-glow-x', '--lg-glow-y', '--lg-glow-size'];
const rubberBand = (offset: number, limit: number) => Math.sign(offset) * limit * (1 - 1 / (Math.abs(offset) * .55 / limit + 1));

export function createGlassInteraction(element: HTMLButtonElement) {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  const saved = { translate: element.style.translate, scale: element.style.scale };
  const tx = new Spring(0, springs.track), ty = new Spring(0, springs.track);
  const press = new Spring(0, springs.press), glow = new Spring(0, springs.glow);
  const all = [tx, ty, press, glow];
  let pointer: { id: number; x: number; y: number; cx: number; cy: number; clientX: number; clientY: number; lastX: number; lastY: number } | null = null;
  let keyboard = false, hovering = false, visible = true, destroyed = false, written = false, sampled = false;
  let frame = 0, previous = 0, glowX = 0, glowY = 0, carriedX = 0, carriedY = 0;
  const disabled = () => element.matches(":disabled, [data-disabled], [aria-disabled='true']");
  const size = () => ({ width: element.offsetWidth || 1, height: element.offsetHeight || 1 });
  const layout = () => {
    const rect = element.getBoundingClientRect(), { width, height } = size();
    return { cx: rect.left + rect.width / 2 - tx.value, cy: rect.top + rect.height / 2 - ty.value,
      width, height, rect, ratioX: width / (rect.width || 1), ratioY: height / (rect.height || 1) };
  };
  const light = (x: number, y: number) => {
    const { rect, ratioX, ratioY } = layout();
    glowX = (x - rect.left) * ratioX;
    glowY = (y - rect.top) * ratioY;
  };
  const set = (spring: Spring, target: number, options: SpringOptions) => { spring.configure(options).target = target; };
  const write = (name: string, value: string) => {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  };
  const canAnimate = () => !destroyed && visible && !doc.hidden && element.isConnected;
  const moving = () => !!pointer || all.some(spring => !spring.settled);
  function wake() {
    if (canAnimate() && !frame) frame = view.requestAnimationFrame(tick);
  }
  function pause() {
    if (frame) view.cancelAnimationFrame(frame);
    frame = previous = 0;
  }
  function move(event: PointerEvent) {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    wake();
  }
  function release(event?: PointerEvent) {
    if (event && (!pointer || event.pointerId !== pointer.id)) return;
    // A native click can disable translation before its first paint; retain one upstream spring step.
    if ((pointer || keyboard) && !sampled) { press.step(1 / 60); glow.step(1 / 60); }
    pointer = null;
    keyboard = false;
    view.removeEventListener('pointermove', move);
    view.removeEventListener('pointerup', release);
    view.removeEventListener('pointercancel', release);
    set(press, 0, springs.release);
    set(tx, 0, springs.release);
    set(ty, 0, springs.release);
    set(glow, hovering ? .35 : 0, springs.glow);
    delete element.dataset.glassPressed;
    wake();
  }
  function cancel() { hovering = false; release(); }
  function down(event: PointerEvent) {
    if (claimed.has(event) || event.button !== 0 || disabled() || pointer || keyboard || !canAnimate()) return;
    claimed.add(event);
    const { cx, cy } = layout();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, cx, cy,
      clientX: event.clientX, clientY: event.clientY, lastX: cx, lastY: cy };
    carriedX = carriedY = 0;
    sampled = false;
    light(event.clientX, event.clientY);
    set(press, 1, springs.press);
    set(glow, 1, springs.press);
    const { width, height } = size();
    const follow = { duration: springs.track.duration + .0005 * Math.max(width, height), bounce: 0 };
    set(tx, 0, follow);
    set(ty, 0, follow);
    // No pointer capture: a drag released outside must retain native button cancellation.
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', release);
    view.addEventListener('pointercancel', release);
    element.dataset.glassPressed = '';
    wake();
  }
  function hover(event: PointerEvent) {
    if (event.pointerType === 'touch' || disabled() || !canAnimate() || !view.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    hovering = event.type !== 'pointerleave';
    if (hovering) light(event.clientX, event.clientY);
    if (!pointer && !keyboard) set(glow, hovering ? .35 : 0, springs.glow);
    wake();
  }
  function key(event: KeyboardEvent) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    if (event.type === 'keydown') {
      if (event.repeat || claimed.has(event) || disabled() || pointer || keyboard || !canAnimate()) return;
      claimed.add(event);
      keyboard = true;
      sampled = false;
      const { width, height } = size();
      glowX = width / 2; glowY = height / 2;
      set(press, 1, springs.press);
      set(glow, 1, springs.press);
      element.dataset.glassPressed = '';
      wake();
    } else if (keyboard) release();
  }
  function drag(event: DragEvent) {
    if (!pointer) return;
    const origin = event.target as Node | null;
    const source = origin?.nodeType === 1 ? origin as Element : origin?.parentElement;
    if (!source?.closest('[draggable="true"]')) event.preventDefault();
  }
  const focusout = () => { if (keyboard) { hovering = false; release(); } };
  function refresh() {
    if (destroyed) return;
    if (disabled() && (pointer || keyboard || hovering)) cancel();
    if (!canAnimate()) { cancel(); pause(); }
    else if (moving()) wake();
  }
  function tick(now: number) {
    frame = 0;
    if (!canAnimate()) { cancel(); pause(); return; }
    const dt = previous ? Math.max(0, (now - previous) / 1000) : 1 / 60;
    previous = now;
    const { width, height } = size();
    if (pointer) {
      const { cx, cy } = layout();
      const small = Math.max(width, height) <= 72;
      const ox = small ? pointer.clientX - pointer.x - (cx - pointer.cx)
        : pointer.clientX - Math.max(cx - width / 2, Math.min(cx + width / 2, pointer.clientX));
      const oy = small ? pointer.clientY - pointer.y - (cy - pointer.cy)
        : pointer.clientY - Math.max(cy - height / 2, Math.min(cy + height / 2, pointer.clientY));
      const limit = small ? 4 + .15 * Math.max(width, height) : Math.min(10, 3 + .04 * Math.max(width, height));
      tx.target = rubberBand(ox, limit);
      ty.target = rubberBand(oy, limit);
      light(pointer.clientX, pointer.clientY);
      carriedX += ((cx - pointer.lastX) / dt - carriedX) * Math.min(1, dt * 12);
      carriedY += ((cy - pointer.lastY) / dt - carriedY) * Math.min(1, dt * 12);
      pointer.lastX = cx; pointer.lastY = cy;
    } else {
      carriedX *= Math.exp(-dt * 10); carriedY *= Math.exp(-dt * 10);
    }
    for (const spring of all) spring.step(dt);
    if (pointer || keyboard) sampled = true;
    const grow = Math.min(.16, 8 / Math.max(width, height)) * press.value;
    const cap = Math.max(width, height) <= 72 ? .2 : .12;
    const ex = Math.min(cap, .5 * Math.abs(tx.value) / width + .00007 * Math.abs(tx.velocity) + .00005 * Math.abs(carriedX));
    const ey = Math.min(cap, .5 * Math.abs(ty.value) / height + .00007 * Math.abs(ty.velocity) + .00005 * Math.abs(carriedY));
    const sx = (1 + grow) * (1 + ex) / Math.sqrt(1 + ey), sy = (1 + grow) * (1 + ey) / Math.sqrt(1 + ex);
    const moved = Math.abs(tx.value) > .01 || Math.abs(ty.value) > .01;
    const scaled = Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4;
    const lit = glow.value > .001;
    if (moved || scaled || lit || pointer || keyboard) {
      written = true;
      write('translate', moved ? `${tx.value.toFixed(3)}px ${ty.value.toFixed(3)}px` : saved.translate);
      write('scale', scaled ? `${sx.toFixed(5)} ${sy.toFixed(5)}` : saved.scale);
      write('--lg-glow', lit ? glow.value.toFixed(4) : '0');
      write('--lg-glow-x', `${glowX.toFixed(2)}px`);
      write('--lg-glow-y', `${glowY.toFixed(2)}px`);
      write('--lg-glow-size', `${Math.max(36, Math.min(180, Math.max(width, height) * .9)).toFixed(1)}px`);
    } else if (written) {
      written = false;
      element.style.translate = saved.translate;
      element.style.scale = saved.scale;
      for (const name of glowProperties) element.style.removeProperty(name);
    }
    if (moving()) wake();
    else previous = 0;
  }
  element.addEventListener('pointerdown', down);
  element.addEventListener('dragstart', drag);
  element.addEventListener('pointerenter', hover);
  element.addEventListener('pointermove', hover);
  element.addEventListener('pointerleave', hover);
  element.addEventListener('keydown', key);
  element.addEventListener('keyup', key);
  element.addEventListener('focusout', focusout);
  view.addEventListener('blur', cancel);
  doc.addEventListener('visibilitychange', refresh);
  const mutations = typeof MutationObserver !== 'undefined' ? new MutationObserver(refresh) : null;
  mutations?.observe(element, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-disabled'] });
  return {
    refresh,
    setVisible(value: boolean) { visible = value; refresh(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      pause();
      mutations?.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('dragstart', drag);
      element.removeEventListener('pointerenter', hover);
      element.removeEventListener('pointermove', hover);
      element.removeEventListener('pointerleave', hover);
      element.removeEventListener('keydown', key);
      element.removeEventListener('keyup', key);
      element.removeEventListener('focusout', focusout);
      view.removeEventListener('blur', cancel);
      doc.removeEventListener('visibilitychange', refresh);
      element.style.translate = saved.translate;
      element.style.scale = saved.scale;
      for (const name of glowProperties) element.style.removeProperty(name);
      delete element.dataset.glassPressed;
    },
  };
}
