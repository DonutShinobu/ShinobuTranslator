/*!
 * Convex profile / Snell / slope field / reflected rim / specular adapted from AndrewPrifer/liquid-dom:
 * https://github.com/AndrewPrifer/liquid-dom/blob/dd342ab663d718e8b4edf4cd39983b9a873360a7/packages/core/src/shaders.ts#L467
 * https://github.com/AndrewPrifer/liquid-dom/blob/dd342ab663d718e8b4edf4cd39983b9a873360a7/packages/core/src/shaders.ts#L701
 * https://github.com/AndrewPrifer/liquid-dom/blob/dd342ab663d718e8b4edf4cd39983b9a873360a7/packages/core/src/shaders.ts#L791
 * Edge-distance and displacement encoding: https://kube.io/blog/liquid-glass-css-svg/
 * This small-button SVG port approximates slope smoothing with five analytic taps and luminance gates with LUTs.
 *
 * MIT License — Copyright (c) 2026 Andras Prifer
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

import { refreshButtonContrast } from './buttonContrast';

const ns = 'http://www.w3.org/2000/svg';
const optical = { bevel: 8, travel: 16, ior: 1.5, maxOffset: 24, dispersion: .01, slopeStep: 1.2 };
const mapCache = new Map<string, { map: string[]; rim: string[]; reflection: string[] }>();
let nextFilterId = 0;

function surfaceProfile(depth: number) {
  const t = Math.max(0, Math.min(1, depth / optical.bevel));
  const flat = Math.max(.0001, 1 - Math.pow(1 - t, 4));
  return {
    height: optical.bevel * Math.sqrt(flat),
    slope: Math.min(2 * Math.pow(1 - t, 3) / Math.sqrt(flat), Math.tan(85 * Math.PI / 180)),
  };
}

function refractedDistance(slope: number, height: number, ior: number) {
  const incident = Math.atan(slope);
  const transmitted = Math.asin(Math.sin(incident) / ior);
  return Math.tan(incident - transmitted) * (optical.travel + height);
}

function surfaceAt(x: number, y: number, width: number, height: number) {
  const radius = height / 2;
  const px = x - width / 2;
  const py = y - height / 2;
  const halfLine = Math.max(0, width / 2 - radius);
  const qx = px - Math.max(-halfLine, Math.min(halfLine, px));
  const length = Math.hypot(qx, py);
  const depth = radius - length;
  const nx = length ? qx / length : 0;
  const ny = length ? py / length : 0;
  const profile = surfaceProfile(depth);
  return { depth, nx, ny, height: profile.height, sx: nx * profile.slope, sy: ny * profile.slope, coverage: Math.max(0, Math.min(1, depth + .5)) };
}

function fieldAt(x: number, y: number, height: number, ior: number) {
  const center = surfaceAt(x, y, 160, height);
  const step = optical.slopeStep;
  const taps = [[0, 0, .4], [step, 0, .15], [-step, 0, .15], [0, step, .15], [0, -step, .15]];
  let sx = 0, sy = 0, coverage = 0;
  for (const [dx, dy, weight] of taps) {
    const sample = dx === 0 && dy === 0 ? center : surfaceAt(x + dx, y + dy, 160, height);
    const contribution = sample.coverage * weight;
    sx += sample.sx * contribution;
    sy += sample.sy * contribution;
    coverage += contribution;
  }
  if (coverage > 0) { sx /= coverage; sy /= coverage; }
  const slope = Math.hypot(sx, sy);
  const bend = refractedDistance(slope, center.height, ior);
  return { dx: slope ? -sx / slope * bend : 0, dy: slope ? -sy / slope * bend : 0, depth: center.depth, nx: center.nx, ny: center.ny };
}

function lensMaps(doc: Document, height: number, dpr: number, ior: number) {
  const key = `${height}:${dpr}:${ior}`;
  const cached = mapCache.get(key);
  if (cached) return cached;
  const canvas = doc.createElement('canvas');
  canvas.width = Math.ceil(38 * dpr);
  canvas.height = Math.ceil(height * dpr);
  const context = canvas.getContext?.('2d');
  if (!context) return null;
  const displacement = context.createImageData(canvas.width, canvas.height);
  const highlight = context.createImageData(canvas.width, canvas.height);
  const reflection = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const px = (x + .5) / dpr;
    // Fixed caps stay 18px; only a pure-y 2px center strip stretches with the label.
    const sampleX = px < 18 ? px : px >= 20 ? 160 - (38 - px) : 80;
    const ray = fieldAt(sampleX, (y + .5) / dpr, height, ior);
    const i = (y * canvas.width + x) * 4;
    displacement.data[i] = Math.round(127.5 + 127.5 * ray.dx / optical.maxOffset);
    displacement.data[i + 1] = Math.round(127.5 + 127.5 * ray.dy / optical.maxOffset);
    displacement.data[i + 2] = 128;
    displacement.data[i + 3] = 255;
    reflection.data[i] = Math.round(127.5 + 127.5 * ray.nx * 18 / optical.maxOffset);
    reflection.data[i + 1] = Math.round(127.5 + 127.5 * ray.ny * 18 / optical.maxOffset);
    reflection.data[i + 2] = 128;
    reflection.data[i + 3] = 255;
    if (ray.depth >= 0 && ray.depth < 1) {
      const dot = -(ray.nx + ray.ny) * Math.SQRT1_2;
      // Reference defaults: 45° main/opposite lights, pow2, .45 opacity, 1px quadratic rim falloff.
      const rim = Math.max(0, 1 - ray.depth * ray.depth);
      const lit = .45 * (Math.pow(Math.max(0, dot), 2) + Math.pow(Math.max(0, -dot), 2)) * rim;
      highlight.data[i] = 255;
      highlight.data[i + 1] = 255;
      highlight.data[i + 2] = 255;
      highlight.data[i + 3] = Math.round(255 * lit);
    }
  }
  const split = () => [[0, 18], [18, 2], [20, 18]].map(([x, width]) => {
    const part = doc.createElement('canvas');
    part.width = Math.round(width * dpr);
    part.height = canvas.height;
    const partContext = part.getContext('2d');
    if (!partContext) throw new Error('Canvas unavailable');
    partContext.drawImage(canvas, x * dpr, 0, width * dpr, canvas.height, 0, 0, part.width, part.height);
    return part.toDataURL();
  });
  context.putImageData(displacement, 0, 0);
  const map = split();
  context.putImageData(highlight, 0, 0);
  const rim = split();
  context.putImageData(reflection, 0, 0);
  const maps = { map, rim, reflection: split() };
  if (mapCache.size >= 12) mapCache.delete(mapCache.keys().next().value!);
  mapCache.set(key, maps);
  return maps;
}

export function createLiquidGlass(button: HTMLButtonElement) {
  const doc = button.ownerDocument || document;
  const view = doc.defaultView || window;
  const material = doc.createElement('span');
  material.className = 'mt-x-glass-material';
  material.setAttribute('aria-hidden', 'true');
  button.classList.add('mt-x-liquid');
  button.prepend(material);
  let running = false, visible = true, destroyed = false, frame = 0;
  let symbols: SVGSVGElement | null = null;
  let filter: SVGFilterElement | null = null;
  let slices: SVGElement[][] = [];
  let lensHeight = 0, lensDpr = 0;
  // shortcut: Firefox lacks SVG backdrop refraction; use uniform .95px frost there.
  let supportsRefraction = /Chrome\/|Chromium\/|Edg\//.test(view.navigator?.userAgent || '')
    && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url("#probe")')
    && typeof doc.createElementNS === 'function';

  function node<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>) {
    const element = doc.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function installLens(width: number, height: number, dpr: number) {
    const maps = [optical.ior + optical.dispersion, optical.ior, optical.ior - optical.dispersion]
      .map(ior => lensMaps(doc, height, dpr, ior));
    if (maps.some(map => !map)) { supportsRefraction = false; return; }
    if (!symbols) {
      symbols = node('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false', style: 'position:absolute;overflow:hidden;pointer-events:none' });
      button.prepend(symbols);
    }
    const margin = optical.maxOffset + 3;
    filter = node('filter', {
      id: `mt-x-lens-${++nextFilterId}`, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB', x: -margin, y: -margin, width: width + margin * 2, height: height + margin * 2,
    });
    slices = [];
    filter.append(node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: .95, result: 'uniform-frost' }));
    function appendSlices(urls: string[], result: string) {
      const images = urls.map((href, i) => node('feImage', {
        href, x: i === 0 ? 0 : i === 1 ? 18 : width - 18, y: 0,
        width: i === 1 ? width - 36 : 18, height, preserveAspectRatio: 'none', result: `${result}-${i}`,
      }));
      filter!.append(...images);
      const merge = node('feMerge', { result });
      for (let i = 0; i < 3; i++) merge.append(node('feMergeNode', { in: `${result}-${i}` }));
      filter!.append(merge);
      slices.push(images);
    }
    for (const [index, channel] of ['r', 'g', 'b'].entries()) {
      appendSlices(maps[index]!.map, `field-${channel}`);
      // W3C scale*(channel-.5) requires twice the PNG encoding range.
      filter.append(node('feDisplacementMap', { in: 'uniform-frost', in2: `field-${channel}`, scale: 2 * optical.maxOffset, xChannelSelector: 'R', yChannelSelector: 'G', result: `refracted-${channel}` }));
      const matrix = new Array<number>(20).fill(0);
      matrix[index * 6] = 1;
      matrix[18] = 1;
      filter.append(node('feColorMatrix', { in: `refracted-${channel}`, type: 'matrix', values: matrix.join(' '), result: channel }));
    }
    filter.append(node('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }));
    filter.append(node('feBlend', { in: 'rg', in2: 'b', mode: 'screen', result: 'rgb' }));
    // The source reflects the same backdrop outward along the unsmoothed rim normal.
    appendSlices(maps[1]!.reflection, 'reflection-field');
    filter.append(node('feDisplacementMap', { in: 'uniform-frost', in2: 'reflection-field', scale: 2 * optical.maxOffset, xChannelSelector: 'R', yChannelSelector: 'G', result: 'reflected' }));
    const luminanceMatrix = new Array<number>(20).fill(0);
    luminanceMatrix.splice(15, 3, .2126, .7152, .0722);
    for (const [input, result, low, high, inverse] of [
      ['reflected', 'reflection-presence', .2, .85, false],
      ['rgb', 'reflection-acceptance', .35, .85, true],
    ] as const) {
      filter.append(node('feColorMatrix', { in: input, type: 'matrix', values: luminanceMatrix.join(' '), result: `${result}-luma` }));
      // 33-point SVG table approximates the source's smoothstep luminance gates.
      const table = Array.from({ length: 33 }, (_, index) => {
        const t = Math.max(0, Math.min(1, (index / 32 - low) / (high - low)));
        const value = t * t * (3 - 2 * t);
        return (inverse ? 1 - value : value).toFixed(6);
      });
      const transfer = node('feComponentTransfer', { in: `${result}-luma`, result });
      transfer.append(node('feFuncA', { type: 'table', tableValues: table.join(' ') }));
      filter.append(transfer);
    }
    filter.append(node('feComposite', { in: 'reflection-presence', in2: 'reflection-acceptance', operator: 'in', result: 'reflection-gate' }));
    filter.append(node('feComposite', { in: 'reflected', in2: 'reflection-gate', operator: 'in', result: 'accepted-reflection' }));
    filter.append(node('feComposite', { in: 'accepted-reflection', in2: 'rgb', operator: 'over', result: 'edge-colour' }));
    appendSlices(maps[1]!.rim, 'rim');
    const rimMask = node('feComponentTransfer', { in: 'rim', result: 'rim-mask' });
    rimMask.append(node('feFuncA', { type: 'linear', slope: 1 / .45 }));
    filter.append(rimMask);
    filter.append(node('feComposite', { in: 'edge-colour', in2: 'rim-mask', operator: 'in', result: 'coloured-rim' }));
    const tint = node('feFlood', { result: 'interior-tint' });
    tint.style.setProperty('flood-color', 'var(--mt-glass-tint,#fff8fc0d)');
    filter.append(tint);
    filter.append(node('feComposite', { in: 'interior-tint', in2: 'rgb', operator: 'over', result: 'interior' }));
    filter.append(node('feComposite', { in: 'coloured-rim', in2: 'interior', operator: 'over', result: 'glass-with-reflection' }));
    // Reference adds white specular RGB; alpha-over would fade on bright backdrops.
    // SVG arithmetic clamps the opaque backdrop's alpha to 1. Keep sRGB for PNG displacement encoding.
    filter.append(node('feComposite', { in: 'glass-with-reflection', in2: 'rim', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0 }));
    material.className = 'mt-x-glass-material mt-x-glass-refracted';
    const defs = node('defs', {});
    defs.append(filter);
    symbols.replaceChildren(defs);
    lensHeight = height;
    lensDpr = dpr;
  }

  function shouldIlluminate() {
    return running && !destroyed && !doc.hidden && button.isConnected && visible;
  }

  function tick(now: number) {
    frame = 0;
    if (!shouldIlluminate()) { syncLight(); return; }
    // Material/Fluent combine rotation and eased arc motion; integrated sine keeps loop velocity continuous.
    // https://github.com/material-components/material-web/blob/main/progress/internal/_circular-progress.scss
    // https://github.com/microsoft/fluentui/blob/master/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts
    const cycle = now / 1000 * Math.PI * 2 / 3.2;
    const angle = cycle - .78 * Math.sin(cycle);
    const tail = .38 + .19 * (1 - Math.cos(cycle));
    material.style.setProperty('--flow-x', `${(50 + 53 * Math.cos(angle)).toFixed(3)}%`);
    material.style.setProperty('--flow-y', `${(50 + 62 * Math.sin(angle)).toFixed(3)}%`);
    material.style.setProperty('--flow-tail-x', `${(50 + 53 * Math.cos(angle - tail)).toFixed(3)}%`);
    material.style.setProperty('--flow-tail-y', `${(50 + 62 * Math.sin(angle - tail)).toFixed(3)}%`);
    frame = view.requestAnimationFrame(tick);
  }

  function syncLight() {
    const active = shouldIlluminate() && typeof view.requestAnimationFrame === 'function';
    material.style.setProperty('--activity-light', active ? '.88' : '0');
    if (!active && frame) { view.cancelAnimationFrame(frame); frame = 0; }
    if (active && !frame) frame = view.requestAnimationFrame(tick);
  }

  function refresh() {
    if (destroyed) return;
    refreshButtonContrast(button);
    const width = button.offsetWidth;
    const height = button.offsetHeight;
    if (supportsRefraction && width >= 36 && height > 0) {
      const dpr = Math.min(2, view.devicePixelRatio || 1);
      try {
        if (!filter || lensHeight !== height || lensDpr !== dpr) installLens(width, height, dpr);
        if (filter && supportsRefraction) {
          filter.setAttribute('width', String(width + (optical.maxOffset + 3) * 2));
          for (const parts of slices) {
            parts[1].setAttribute('width', String(width - 36));
            parts[2].setAttribute('x', String(width - 18));
          }
          const documentUrl = (doc.URL || '').split('#')[0].replaceAll('"', '%22');
          const backdrop = `url("${documentUrl}#${filter.id}")`;
          material.style.setProperty('backdrop-filter', backdrop);
          material.style.setProperty('-webkit-backdrop-filter', backdrop);
        }
      } catch {
        supportsRefraction = false;
        symbols?.remove();
        material.style.removeProperty('backdrop-filter');
        material.style.removeProperty('-webkit-backdrop-filter');
        material.className = 'mt-x-glass-material';
      }
    }
    syncLight();
  }

  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null;
  resize?.observe(button);
  const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) refresh(); else syncLight();
  }) : null;
  intersection?.observe(button);
  const onBackdropLoad = (event: Event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const imageRect = image.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (imageRect.right > buttonRect.left && imageRect.left < buttonRect.right
      && imageRect.bottom > buttonRect.top && imageRect.top < buttonRect.bottom) refresh();
  };
  doc.addEventListener?.('load', onBackdropLoad, true);
  doc.addEventListener?.('visibilitychange', syncLight);
  refresh();

  return {
    material,
    refresh,
    setRunning(value: boolean) { running = value; syncLight(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      syncLight();
      resize?.disconnect();
      intersection?.disconnect();
      doc.removeEventListener?.('load', onBackdropLoad, true);
      doc.removeEventListener?.('visibilitychange', syncLight);
      symbols?.remove();
      material.remove();
    },
  };
}
