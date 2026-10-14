/*!
 * Clear/light displacement, overlay and tone adapted from Glass-HQ/liquid-glass:
 * https://github.com/Glass-HQ/liquid-glass/blob/9f5bfc7daa7be5d20a41b94d841b8f065de655fc/packages/liquid-glass/src/gpu/maps.wgsl
 * https://github.com/Glass-HQ/liquid-glass/blob/9f5bfc7daa7be5d20a41b94d841b8f065de655fc/packages/liquid-glass/src/dom/material-graph.ts
 * https://github.com/Glass-HQ/liquid-glass/blob/9f5bfc7daa7be5d20a41b94d841b8f065de655fc/packages/liquid-glass/src/dom/map-image.ts
 * Port uses circular caps and idle 45-degree / busy paired travelling light, instead of Lisse's squircle / vertical light.
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

import { refreshButtonContrast } from './buttonContrast';
import { createGlassInteraction } from './glassInteraction';
import { observeContentBooleanPreference } from '../contentPreference';

const ns = 'http://www.w3.org/2000/svg';
const refraction = 60;
const padding = 2;
const lightPeriod = 2800;
const mapCache = new Map<string, { field: string[]; shade: string[]; normal: string[]; diffuse: string[] }>();
let nextFilterId = 0;

const saturate = (value: number) => Math.max(0, Math.min(1, value));
const directional = (normal: number, spread: number) => Math.pow(saturate((Math.abs(normal) - Math.cos(spread)) / (1 - Math.cos(spread))), 1.25);

function contourAt(progress: number, width: number, height: number) {
  const vertical = height > width;
  const w = Math.max(width, height), h = Math.min(width, height);
  const radius = h / 2, straight = w - h, perimeter = 2 * straight + 2 * Math.PI * radius;
  const distance = ((progress * perimeter - Math.PI * radius / 4) % perimeter + perimeter) % perimeter;
  let x: number, y: number, nx: number, ny: number;
  if (distance < straight) {
    x = radius + distance; y = 0; nx = 0; ny = -1;
  } else if (distance < straight + Math.PI * radius) {
    const angle = (distance - straight) / radius - Math.PI / 2;
    nx = Math.cos(angle); ny = Math.sin(angle); x = w - radius + radius * nx; y = radius + radius * ny;
  } else if (distance < 2 * straight + Math.PI * radius) {
    x = w - radius - (distance - straight - Math.PI * radius); y = h; nx = 0; ny = 1;
  } else {
    const angle = (distance - 2 * straight - Math.PI * radius) / radius + Math.PI / 2;
    nx = Math.cos(angle); ny = Math.sin(angle); x = radius + radius * nx; y = radius + radius * ny;
  }
  return { x: vertical ? y : x, y: vertical ? height - x : y,
    nx: vertical ? ny : nx, ny: vertical ? -nx : ny, perimeter };
}

function surfaceAt(x: number, y: number, width: number, height: number) {
  const radius = Math.min(width, height) / 2;
  const px = x - width / 2;
  const py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - radius);
  const qy = Math.abs(py) - (height / 2 - radius);
  const ox = Math.max(0, qx), oy = Math.max(0, qy);
  const length = Math.hypot(ox, oy);
  return {
    distance: length + Math.min(Math.max(qx, qy), 0) - radius,
    nx: length ? Math.sign(px) * ox / length : qx > qy ? Math.sign(px) || 1 : 0,
    ny: length ? Math.sign(py) * oy / length : qx > qy ? 0 : Math.sign(py) || 1,
  };
}

function lensMaps(doc: Document, width: number, height: number, dpr: number) {
  const sliced = width >= 2 * height;
  const sourceWidth = sliced ? 3 * height : width;
  const key = `${sourceWidth}:${height}:${dpr}:${sliced}`;
  const cached = mapCache.get(key);
  if (cached) return cached;
  const canvas = doc.createElement('canvas');
  canvas.width = Math.ceil((sourceWidth + 2 * padding) * dpr);
  canvas.height = Math.ceil((height + 2 * padding) * dpr);
  const context = canvas.getContext?.('2d');
  if (!context) return null;
  const displacement = context.createImageData(canvas.width, canvas.height);
  const shadow = context.createImageData(canvas.width, canvas.height);
  const normal = context.createImageData(canvas.width, canvas.height);
  const diffuseProfile = context.createImageData(canvas.width, canvas.height);
  const step = .5 / dpr;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const px = (x + .5) / dpr - padding;
    const py = (y + .5) / dpr - padding;
    const ray = surfaceAt(px, py, sourceWidth, height);
    const distance = ray.distance;
    const aa = Math.max(1 / dpr,
      Math.abs(surfaceAt(px + step, py, sourceWidth, height).distance - surfaceAt(px - step, py, sourceWidth, height).distance)
      + Math.abs(surfaceAt(px, py + step, sourceWidth, height).distance - surfaceAt(px, py - step, sourceWidth, height).distance));
    const coverage = saturate(.5 - distance / aa);
    const depth = saturate(-distance * .05);
    const edge = 1 - saturate(Math.sqrt((2 - depth) * depth));
    const i = (y * canvas.width + x) * 4;
    displacement.data[i] = Math.round(255 * (.5 - .5 * ray.nx * edge));
    displacement.data[i + 1] = Math.round(255 * (.5 - .5 * ray.ny * edge));
    displacement.data[i + 2] = 128;
    // CSS clips the button shape; opaque map pixels preserve displacement RGB at antialiased edges.
    displacement.data[i + 3] = 255;
    const side = (ray.nx - ray.ny) * Math.SQRT1_2;
    const stroke = saturate((distance + .9) / aa + .5) * saturate(.5 - distance / aa);
    // Opaque normals survive unpremultiplication; B carries the source's stroke mask.
    normal.data[i] = Math.round(255 * (.5 + .5 * ray.nx));
    normal.data[i + 1] = Math.round(255 * (.5 + .5 * ray.ny));
    normal.data[i + 2] = Math.round(255 * stroke);
    normal.data[i + 3] = 255;
    // Opaque RGB slices avoid adding diffuse alpha twice at their half-pixel overlaps.
    diffuseProfile.data[i] = diffuseProfile.data[i + 1] = diffuseProfile.data[i + 2] = Math.round(255 * .18 * Math.pow(1 - saturate(-distance / 4.5), 2) * coverage);
    diffuseProfile.data[i + 3] = 255;
    const adjusted = distance - .5;
    const falloff = 1 - saturate(-adjusted / .5);
    const ramp = .25 * (falloff > 0 ? 1 : 0) + .75 * falloff;
    const outline = ramp * saturate((adjusted + .5) / aa + .5) * saturate(-adjusted / aa + .5);
    let shade = 0;
    for (const direction of [side, -side]) {
      const weight = saturate((direction - Math.cos(.98)) / (1 - Math.cos(.98))) * outline;
      shade += weight / (1 + .4 * (1 - weight));
    }
    shadow.data[i + 3] = Math.round(255 * .48 * shade);
  }
  const cap = height + padding;
  const split = () => (sliced ? [[0, cap], [cap, sourceWidth + 2 * padding - 2 * cap], [sourceWidth + 2 * padding - cap, cap]] : [[0, sourceWidth + 2 * padding]]).map(([x, width]) => {
    const part = doc.createElement('canvas');
    part.width = Math.round(width * dpr);
    part.height = canvas.height;
    const partContext = part.getContext('2d');
    if (!partContext) throw new Error('Canvas unavailable');
    partContext.drawImage(canvas, x * dpr, 0, width * dpr, canvas.height, 0, 0, part.width, part.height);
    return part.toDataURL();
  });
  context.putImageData(displacement, 0, 0);
  const field = split();
  context.putImageData(shadow, 0, 0);
  const shadeSlices = split();
  context.putImageData(normal, 0, 0);
  const normalSlices = split();
  context.putImageData(diffuseProfile, 0, 0);
  const maps = { field, shade: shadeSlices, normal: normalSlices, diffuse: split() };
  if (mapCache.size >= 12) mapCache.delete(mapCache.keys().next().value!);
  mapCache.set(key, maps);
  return maps;
}

export function createLiquidGlass(button: HTMLElement, onVisibilityChange?: (visible: boolean) => void) {
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
  let overlay: SVGSVGElement | null = null;
  let shadeSlices: SVGImageElement[] = [];
  let activitySlices: SVGImageElement[] = [];
  let diffuseSlices: SVGFEImageElement[] = [];
  let activityFilter: SVGFilterElement | null = null;
  let lightProjection: SVGFEColorMatrixElement | null = null;
  let lightColor: SVGFEFloodElement | null = null;
  let activity: SVGGElement | null = null;
  let activityMask: SVGMaskElement | null = null;
  let maskBase: SVGRectElement | null = null;
  let heads: SVGCircleElement[] = [], tails: SVGCircleElement[] = [];
  let headGradient: SVGRadialGradientElement | null = null, tailGradient: SVGRadialGradientElement | null = null;
  let lightCycle = 0;
  let lightStartedAt: number | null = null;
  let settling: { from: number; to: number; duration: number; elapsed: number; startedAt: number | null } | null = null;
  let lightWidth = 0, lightHeight = 0;
  let lensHeight = 0, lensDpr = 0, lensWidth = 0;
  let supportsOptics = typeof doc.createElementNS === 'function';
  // shortcut: Firefox lacks SVG backdrop refraction; retain the transparent CSS material there.
  let supportsRefraction = /Chrome\/|Chromium\/|Edg\//.test(view.navigator?.userAgent || '')
    && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url("#probe")')
    && supportsOptics;

  function node<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>) {
    const element = doc.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function installLens(width: number, height: number, dpr: number) {
    const previousColor = lightColor && view.getComputedStyle?.(lightColor).floodColor;
    const maps = lensMaps(doc, width, height, dpr);
    if (!maps) { supportsOptics = false; supportsRefraction = false; return; }
    if (!symbols) {
      symbols = node('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false', style: 'position:absolute;overflow:hidden;pointer-events:none' });
      button.prepend(symbols);
    }
    const margin = refraction + padding;
    const defs = node('defs', {});
    filter = supportsRefraction ? node('filter', {
      id: `mt-x-lens-${++nextFilterId}`, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB', x: -margin, y: -margin, width: width + margin * 2, height: height + margin * 2,
    }) : null;
    slices = [];
    function appendSlices(urls: string[], result: string) {
      const images = urls.map((href, i) => node('feImage', {
        href, x: -padding, y: -padding, width: width + 2 * padding, height: height + 2 * padding,
        preserveAspectRatio: 'none', result: `${result}-${i}`,
      }));
      filter!.append(...images);
      const merge = node('feMerge', { result });
      // Upstream half-pixel underlap keeps fractional transforms from exposing seams.
      for (const i of urls.length === 3 ? [1, 0, 2] : [0]) merge.append(node('feMergeNode', { in: `${result}-${i}` }));
      filter!.append(merge);
      slices.push(images);
    }
    if (filter) {
      appendSlices(maps.field, 'field');
      // Upstream RG = .5 - .5 * normal * edge; W3C scale*(channel-.5) recovers its 60px refraction.
      filter.append(node('feDisplacementMap', { in: 'SourceGraphic', in2: 'field', scale: 2 * refraction, xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' }));
      const table = Array.from({ length: 33 }, (_, index) => {
        const value = index / 32;
        return saturate(.94 * (value + .18 * Math.pow(1 - value, 3)) + .06 * (.78 * value + .26)).toFixed(6);
      }).join(' ');
      const tone = node('feComponentTransfer', { in: 'refracted', result: 'clear-tone' });
      for (const channel of ['feFuncR', 'feFuncG', 'feFuncB'] as const) tone.append(node(channel, { type: 'table', tableValues: table }));
      filter.append(tone);
      defs.append(filter);
    }
    // The source's shade lives outside the shape; a separate padded overlay avoids backdrop's rounded clip.
    overlay = node('svg', { class: 'mt-x-glass-overlay', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'none' });
    shadeSlices = maps.shade.map(href => node('image', { href, y: 0, height: height + 2 * padding, preserveAspectRatio: 'none' }));
    overlay.append(...(shadeSlices.length === 3 ? [shadeSlices[1], shadeSlices[0], shadeSlices[2]] : shadeSlices));
    activityFilter = node('filter', {
      id: `mt-x-rim-${++nextFilterId}`, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB', x: 0, y: 0, width: width + 2 * padding, height: height + 2 * padding,
    });
    lightProjection = node('feColorMatrix', { in: 'SourceGraphic', result: 'light-direction', 'data-glass-light': 'pink' });
    activityFilter.append(lightProjection, node('feColorMatrix', {
      in: 'SourceGraphic', result: 'stroke', values: '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 1 0 0',
    }));
    function transfer(input: string, result: string, curve: (value: number) => number) {
      const table = Array.from({ length: 257 }, (_, i) => curve(i / 256).toFixed(6)).join(' ');
      const primitive = node('feComponentTransfer', { in: input, result });
      primitive.append(node('feFuncA', { type: 'table', tableValues: table }));
      activityFilter!.append(primitive);
    }
    transfer('light-direction', 'specular-direction', value => directional(2 * value - 1, 1.08));
    activityFilter.append(node('feComposite', { in: 'specular-direction', in2: 'stroke', operator: 'in', result: 'specular-raw' }));
    transfer('specular-raw', 'specular', value => value / (1 + .5 * (1 - value)));
    diffuseSlices = maps.diffuse.map((href, i) => node('feImage', {
      href, x: 0, y: 0, width: width + 2 * padding, height: height + 2 * padding,
      preserveAspectRatio: 'none', result: `diffuse-profile-${i}`,
    }));
    activityFilter.append(...diffuseSlices);
    const diffuseMerge = node('feMerge', { result: 'diffuse-rgb' });
    for (const i of diffuseSlices.length === 3 ? [1, 0, 2] : [0]) diffuseMerge.append(node('feMergeNode', { in: `diffuse-profile-${i}` }));
    activityFilter.append(diffuseMerge, node('feColorMatrix', {
      in: 'diffuse-rgb', result: 'diffuse-profile', values: '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0',
    }));
    transfer('light-direction', 'diffuse-direction', value => directional(2 * value - 1, .702));
    lightColor = node('feFlood', { class: 'mt-x-glass-light-color', 'flood-color': previousColor || (running ? '#f18dc6' : '#fff'), result: 'key-light' });
    activityFilter.append(
      node('feComposite', { in: 'diffuse-direction', in2: 'diffuse-profile', operator: 'in', result: 'diffuse' }),
      node('feComposite', { in: 'specular', in2: 'diffuse', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'highlight' }),
      lightColor,
      node('feComposite', { in: 'key-light', in2: 'highlight', operator: 'in' }),
    );
    defs.append(activityFilter);
    function gradient(id: string, stops: [number, number][]) {
      const result = node('radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 1 });
      for (const [offset, opacity] of stops) result.append(node('stop', { offset, 'stop-color': 'white', 'stop-opacity': opacity }));
      defs.append(result);
      return result;
    }
    headGradient = gradient(`${activityFilter.id}-head`, [[0, 1], [.25, .96], [.6, .5], [1, 0]]);
    tailGradient = gradient(`${activityFilter.id}-tail`, [[0, .34], [.35, .24], [.7, .07], [1, 0]]);
    activityMask = node('mask', { id: `${activityFilter.id}-mask`, maskUnits: 'userSpaceOnUse',
      maskContentUnits: 'userSpaceOnUse', x: 0, y: 0, style: 'mask-type:alpha' });
    // Idle retains the full white light; busy uses paired local peaks so flat edges do not light up together.
    maskBase = node('rect', { class: 'mt-x-glass-light-base', x: 0, y: 0, fill: 'white', opacity: running || settling ? 0 : 1 });
    heads = [0, 1].map(index => node('circle', { cx: 0, cy: 0, r: 1, 'data-glass-light': index ? 'opposite-head' : 'head' }));
    tails = [0, 1].map(index => node('circle', { cx: 0, cy: 0, r: 1, 'data-glass-light': index ? 'opposite-tail' : 'tail' }));
    activityMask.append(maskBase, ...tails, ...heads);
    defs.append(activityMask);
    activity = node('g', { class: 'mt-x-glass-activity' });
    activitySlices = maps.normal.map(href => node('image', { href, y: 0, height: height + 2 * padding, preserveAspectRatio: 'none' }));
    activity.append(...(activitySlices.length === 3 ? [activitySlices[1], activitySlices[0], activitySlices[2]] : activitySlices));
    overlay.append(activity);
    material.replaceChildren(overlay);
    material.className = `mt-x-glass-material mt-x-glass-optical${supportsRefraction ? ' mt-x-glass-refracted' : ''}`;
    symbols.replaceChildren(defs);
    // Preserve the in-flight colour transition when the completion label rebuilds narrow cap maps.
    if (previousColor && settling) view.getComputedStyle?.(lightColor).floodColor;
    setLightPose(lightCycle, width, height);
    lensHeight = height;
    lensDpr = dpr;
    lensWidth = width < 2 * height ? width : 0;
  }

  function shouldIlluminate() {
    return (running || !!settling) && !destroyed && !doc.hidden && button.isConnected && visible && !!lightProjection && lightWidth > 0 && lightHeight > 0;
  }

  function setLightPose(cycle: number, width: number, height: number) {
    lightCycle = cycle;
    const progress = (cycle - .42 * Math.sin(2 * cycle)) / (2 * Math.PI);
    const stretch = (1 - Math.cos(2 * cycle)) / 2;
    const size = Math.min(width, height);
    const leading = contourAt(progress, width, height);
    const x = leading.nx, y = leading.ny;
    // Decode RG normals into alpha=.5+.5*dot(normal, light); tables supply the source's angular falloff.
    lightProjection?.setAttribute('values', `0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 ${x.toFixed(6)} ${y.toFixed(6)} 0 0 ${(0.5 - .5 * (x + y)).toFixed(6)}`);
    function place(element: SVGCircleElement, pose: ReturnType<typeof contourAt>, length: number) {
      const thickness = Math.max(6, size * .22);
      element.setAttribute('transform', `matrix(${(-pose.ny * length).toFixed(4)} ${(pose.nx * length).toFixed(4)} ${(pose.nx * thickness).toFixed(4)} ${(pose.ny * thickness).toFixed(4)} ${(pose.x + padding).toFixed(4)} ${(pose.y + padding).toFixed(4)})`);
    }
    for (let index = 0; index < heads.length; index++) {
      place(heads[index], contourAt(progress + index / 2, width, height), size * (.65 + .25 * stretch));
      place(tails[index], contourAt(progress + index / 2 - size * (.35 + .2 * stretch) / leading.perimeter, width, height), size * (.85 + .35 * stretch));
    }
  }

  function tick(now: number) {
    frame = 0;
    if (!shouldIlluminate()) { syncLight(); return; }
    // Material/Fluent combine rotation and eased arc motion; integrated sine keeps loop velocity continuous.
    // https://github.com/material-components/material-web/blob/main/progress/internal/_circular-progress.scss
    // https://github.com/microsoft/fluentui/blob/master/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts
    if (settling) {
      if (settling.startedAt === null) settling.startedAt = now - settling.elapsed;
      settling.elapsed = now - settling.startedAt;
      const t = saturate(settling.elapsed / settling.duration);
      const distance = settling.to - settling.from;
      const tangent = 2 * Math.PI / lightPeriod * settling.duration;
      const cycle = settling.from + distance * (3 * t * t - 2 * t * t * t)
        + tangent * t * (1 - t) * (1 - t);
      setLightPose(cycle, lightWidth, lightHeight);
      if (t === 1) { settling = null; syncLight(); return; }
    } else {
      if (lightStartedAt === null) lightStartedAt = now - lightCycle / (2 * Math.PI) * lightPeriod;
      setLightPose((now - lightStartedAt) / lightPeriod * Math.PI * 2, lightWidth, lightHeight);
    }
    frame = view.requestAnimationFrame(tick);
  }

  function syncLight() {
    const active = shouldIlluminate() && typeof view.requestAnimationFrame === 'function';
    lightColor?.style.setProperty('transition-duration', settling ? `${Math.max(1, settling.duration - settling.elapsed)}ms` : '240ms');
    lightColor?.style.setProperty('flood-color', running && !destroyed ? '#f18dc6' : '#fff');
    maskBase?.style.setProperty('opacity', (running || settling) && !destroyed ? '0' : '1');
    if (!active) {
      if (frame) view.cancelAnimationFrame(frame);
      frame = 0;
      lightStartedAt = null;
      if (settling) settling.startedAt = null;
    }
    if (active && !frame) frame = view.requestAnimationFrame(tick);
  }

  function refresh() {
    if (destroyed) return;
    const width = button.offsetWidth;
    const height = button.offsetHeight;
    lightWidth = width;
    lightHeight = height;
    if (supportsOptics && width > 0 && height > 0) {
      const dpr = Math.min(2, view.devicePixelRatio || 1);
      try {
        const narrowWidth = width < 2 * height ? width : 0;
        if (!overlay || lensHeight !== height || lensDpr !== dpr || lensWidth !== narrowWidth) installLens(width, height, dpr);
        if (overlay && supportsOptics) {
          function positionSlices(parts: SVGElement[], origin: number) {
            parts[0].setAttribute('x', String(origin));
            if (parts.length === 1) { parts[0].setAttribute('width', String(width + 2 * padding)); return; }
            const cap = height + padding;
            parts[0].setAttribute('width', String(cap));
            parts[1].setAttribute('x', String(origin + cap - .5));
            parts[1].setAttribute('width', String(width - 2 * height + 1));
            parts[2].setAttribute('x', String(origin + width + 2 * padding - cap));
            parts[2].setAttribute('width', String(cap));
          }
          for (const parts of slices) positionSlices(parts, -padding);
          for (const parts of [shadeSlices, activitySlices, diffuseSlices]) positionSlices(parts, 0);
          overlay.setAttribute('viewBox', `0 0 ${width + 2 * padding} ${height + 2 * padding}`);
          activityFilter?.setAttribute('width', String(width + 2 * padding));
          for (const element of [activityMask, maskBase]) {
            element?.setAttribute('width', String(width + 2 * padding));
            element?.setAttribute('height', String(height + 2 * padding));
          }
          const documentUrl = (doc.URL || '').split('#')[0].replaceAll('"', '%22');
          activity?.setAttribute('filter', `url("${documentUrl}#${activityFilter!.id}")`);
          activity?.setAttribute('mask', `url("${documentUrl}#${activityMask!.id}")`);
          for (const head of heads) head.setAttribute('fill', `url("${documentUrl}#${headGradient!.id}")`);
          for (const tail of tails) tail.setAttribute('fill', `url("${documentUrl}#${tailGradient!.id}")`);
          setLightPose(lightCycle, width, height);
        }
        if (filter && supportsRefraction) {
          filter.setAttribute('width', String(width + (refraction + padding) * 2));
          const documentUrl = (doc.URL || '').split('#')[0].replaceAll('"', '%22');
          const backdrop = `url("${documentUrl}#${filter.id}")`;
          material.style.setProperty('backdrop-filter', backdrop);
          material.style.setProperty('-webkit-backdrop-filter', backdrop);
        }
      } catch {
        supportsOptics = false;
        supportsRefraction = false;
        symbols?.remove();
        overlay?.remove();
        activityFilter = null;
        lightProjection = null;
        lightColor = null;
        settling = null;
        activityMask = null;
        maskBase = null;
        heads = tails = [];
        headGradient = tailGradient = null;
        activity = null;
        material.style.removeProperty('backdrop-filter');
        material.style.removeProperty('-webkit-backdrop-filter');
        material.className = 'mt-x-glass-material';
      }
    }
    refreshButtonContrast(button);
    syncLight();
  }

  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null;
  resize?.observe(button);
  const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    onVisibilityChange?.(visible);
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
    setRunning(value: boolean) {
      if (value !== running) {
        lightStartedAt = null;
        if (value) {
          if (!settling) lightCycle = 0;
          settling = null;
          if (lightWidth > 0 && lightHeight > 0) setLightPose(lightCycle, lightWidth, lightHeight);
        } else {
          // Opposite highlights repeat every half-turn; Hermite keeps the incoming speed and stops without overshoot.
          const to = Math.ceil(lightCycle / Math.PI - 1e-6) * Math.PI;
          const distance = to - lightCycle;
          if (distance > 1e-6 && lightProjection) {
            settling = { from: lightCycle, to, elapsed: 0, startedAt: view.performance?.now() ?? null,
              duration: Math.min(320, 160 + distance / Math.PI * 320, 2 * distance / (2 * Math.PI / lightPeriod)) };
          } else if (lightWidth > 0 && lightHeight > 0) setLightPose(to, lightWidth, lightHeight);
        }
      }
      running = value;
      syncLight();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      settling = null;
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

const controls = new WeakMap<HTMLElement, {
  glass?: ReturnType<typeof createLiquidGlass>;
  interaction?: ReturnType<typeof createGlassInteraction>;
  stopPreference?: () => void;
  simple?: boolean;
}>();

export function initializeGlassControl(element: HTMLElement): void {
  if (controls.has(element)) return;
  const control: NonNullable<ReturnType<typeof controls.get>> = {};
  controls.set(element, control);
  control.stopPreference = observeContentBooleanPreference('simpleButtons', (enabled) => {
    if (control.simple === enabled) return;
    control.simple = enabled;
    control.interaction?.destroy();
    control.glass?.destroy();
    control.interaction = undefined;
    control.glass = undefined;
    element.classList.toggle('mt-x-simple', enabled);
    element.classList.toggle('mt-x-liquid', !enabled);
    if (!enabled) {
      control.interaction = element.tagName === 'BUTTON'
        ? createGlassInteraction(element as HTMLButtonElement) : undefined;
      control.glass = createLiquidGlass(element, visible => control.interaction?.setVisible(visible));
    }
  });
}

export function refreshGlassControl(element: HTMLElement): void {
  const control = controls.get(element);
  control?.glass?.refresh();
  control?.interaction?.refresh();
}

export function destroyGlassControl(element: HTMLElement): void {
  const control = controls.get(element);
  control?.stopPreference?.();
  control?.interaction?.destroy();
  control?.glass?.destroy();
  controls.delete(element);
}
