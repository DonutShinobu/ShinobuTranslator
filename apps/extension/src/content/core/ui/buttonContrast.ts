import { resolveEditingSurface } from '../editing/imageSurface';

type Ink = 'light' | 'dark' | 'balanced';
const inkColors = { light: [255, 255, 255], dark: [23, 19, 26] };
// Match Glass HQ's Clear/light sRGB transfer before judging the transmitted backdrop.
const clearTone = Array.from({ length: 33 }, (_, index) => {
  const v = index / 32;
  return Math.min(1, .94 * (v + .18 * (1 - v) ** 3) + .06 * (.78 * v + .26));
});
const unreadableImages = new Set<string>();
const unreadableCanvases = new WeakSet<HTMLCanvasElement>();

function luminance(rgb: number[]): number {
  return rgb.reduce((sum, value, index) => {
    const channel = value / 255;
    return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      * [.2126, .7152, .0722][index];
  }, 0);
}

function clearGlyphColors(button: HTMLButtonElement): void {
  for (const node of button.querySelectorAll<HTMLElement>('[torph-item], .mt-x-icon, .mt-x-label')) {
    node.style.removeProperty('color');
    delete node.dataset.ink;
  }
}

function setContrast(button: HTMLButtonElement, ink: Ink, rgb: number[]): void {
  clearGlyphColors(button);
  const color = `rgb(${rgb.join(' ')})`;
  button.style.setProperty('--mt-glass-text', color);
  button.dataset.ink = ink;
  button.dataset.contrast = 'sampled';
}

function fallback(button: HTMLButtonElement): void {
  // shortcut: unreadable pixels retain the last ink or inherited foreground; accurate adaptation needs readable pixels.
  clearGlyphColors(button);
  button.dataset.contrast = 'fallback';
}

function hasColor(color: string): boolean {
  return !!color && color !== 'transparent'
    && !/^rgba\([^)]*,\s*0(?:\.0*)?\s*\)$/u.test(color)
    && !/\/\s*0(?:\.0*)?\s*\)$/u.test(color);
}

function solidBackground(
  context: CanvasRenderingContext2D,
  elements: Element[],
  getStyle: (element: Element) => CSSStyleDeclaration,
  x: number,
  width: number,
): boolean {
  for (const element of elements) {
    const css = getStyle(element);
    if (css.backgroundImage !== 'none' || Number(css.opacity || 1) !== 1) return false;
    const color = css.backgroundColor;
    if (!hasColor(color)) continue;
    context.fillStyle = color;
    context.fillRect(x, 0, width, 6);
    if (context.getImageData(x, 0, 1, 1).data[3] === 255) return true;
    context.clearRect(x, 0, width, 6);
    return false;
  }
  return false;
}

export function refreshButtonContrast(button: HTMLButtonElement): void {
  const overlay = button.closest('.mt-x-overlay-inline');
  if (!overlay) return;
  const doc = button.ownerDocument;
  const view = doc.defaultView;
  if (!view || !button.isConnected) return;
  const bounds = button.getBoundingClientRect();
  const regions = [...button.querySelectorAll<HTMLElement>('.mt-x-label-slot, .mt-x-icon')]
    .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
  if (!regions.length || !bounds.width || !bounds.height) return;
  const left = Math.max(bounds.left, Math.min(...regions.map(rect => rect.left)));
  const right = Math.min(bounds.right, Math.max(...regions.map(rect => rect.right)));
  const top = Math.max(bounds.top, Math.min(...regions.map(rect => rect.top)));
  const bottom = Math.min(bounds.bottom, Math.max(...regions.map(rect => rect.bottom)));
  if (right <= left || bottom <= top) return;
  const canvas = doc.createElement('canvas');
  canvas.width = 16; canvas.height = 6;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) { fallback(button); return; }
  const getStyle = (element: Element) => view.getComputedStyle(element);
  try {
    // Three hit tests cover the icon and both ends of the text; the readback is only 16 × 6.
    for (const [pixelLeft, pixelRight] of [[0, 5], [5, 11], [11, 16]]) {
      const viewportLeft = left + (right - left) * pixelLeft / 16;
      const viewportRight = left + (right - left) * pixelRight / 16;
      const elements = doc.elementsFromPoint((viewportLeft + viewportRight) / 2, (top + bottom) / 2)
        .filter(element => !overlay.contains(element) && !element.closest('.mt-x-overlay-inline'));
      const sourceIndex = elements.findIndex(element => {
        if (element.tagName === 'IMG') return (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0;
        if (element.tagName === 'CANVAS') return (element as HTMLCanvasElement).width > 0 && (element as HTMLCanvasElement).height > 0;
        const color = getStyle(element).backgroundColor;
        return hasColor(color);
      });
      if (sourceIndex < 0) { fallback(button); return; }
      const source = elements[sourceIndex];
      const sourceStyle = getStyle(source);
      context.filter = 'none';
      const solid = solidBackground(context, elements.slice(sourceIndex), getStyle, pixelLeft, pixelRight - pixelLeft);
      if (source.tagName !== 'IMG' && source.tagName !== 'CANVAS') {
        if (!solid) { fallback(button); return; }
        continue;
      }
      const image = source as HTMLImageElement;
      const bitmap = source as HTMLCanvasElement;
      const imageUrl = source.tagName === 'IMG' ? image.currentSrc || image.src : '';
      if ((imageUrl && unreadableImages.has(imageUrl)) || unreadableCanvases.has(bitmap)) { fallback(button); return; }
      // CSS URL filters and rotated/skewed images cannot be reproduced from a rectangular crop without page composition.
      const transform = sourceStyle.transform;
      const matrix = transform && transform !== 'none' ? new view.DOMMatrix(transform) : null;
      if (sourceStyle.filter.includes('url(') || (matrix && (!matrix.is2D || Math.abs(matrix.b) > .0001 || Math.abs(matrix.c) > .0001))) {
        fallback(button); return;
      }
      const size = source.tagName === 'IMG'
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : { width: bitmap.width, height: bitmap.height };
      const surface = resolveEditingSurface(image, size);
      if (!(surface.scaleX > 0 && surface.scaleY > 0)) { fallback(button); return; }
      context.filter = sourceStyle.filter || 'none';
      context.globalAlpha = Number(sourceStyle.opacity || 1);
      try {
        context.drawImage(source as CanvasImageSource,
          (viewportLeft - surface.left - surface.offsetX) / surface.scaleX,
          (top - surface.top - surface.offsetY) / surface.scaleY,
          (viewportRight - viewportLeft) / surface.scaleX, (bottom - top) / surface.scaleY,
          pixelLeft, 0, pixelRight - pixelLeft, 6);
        context.getImageData(pixelLeft, 0, pixelRight - pixelLeft, 6);
      } catch (error) {
        if (error instanceof Error && error.name === 'SecurityError') {
          if (imageUrl) {
            if (unreadableImages.size >= 64) unreadableImages.delete(unreadableImages.values().next().value!);
            unreadableImages.add(imageUrl);
          } else unreadableCanvases.add(bitmap);
        }
        throw error;
      }
      context.globalAlpha = 1;
    }
    const pixels = context.getImageData(0, 0, 16, 6).data;
    const colors: number[][] = [];
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] !== 255) { fallback(button); return; }
      colors.push([pixels[index], pixels[index + 1], pixels[index + 2]]);
    }
    // liquid-dom exposes luminance percentiles; here only the unified ink adapts, leaving the lens clear.
    const refracted = !!button.querySelector('.mt-x-glass-refracted');
    const values = colors.map(rgb => luminance(rgb.map(value => {
      if (!refracted) return value;
      const position = value / 255 * 32;
      const index = Math.min(31, Math.floor(position));
      return 255 * (clearTone[index] + (clearTone[index + 1] - clearTone[index]) * (position - index));
    }))).sort((a, b) => a - b);
    const low = values[Math.floor(values.length * .1)], high = values[Math.floor(values.length * .9)];
    // Equal contrast against both ends of a split backdrop avoids white-on-white without darkening the glass.
    const balancedLuminance = Math.sqrt((low + .05) * (high + .05)) - .05;
    const gray = Math.round(255 * (balancedLuminance <= .0031308 ? balancedLuminance * 12.92
      : 1.055 * balancedLuminance ** (1 / 2.4) - .055));
    const score = (rgb: number[]) => {
      const foreground = luminance(rgb);
      const ratios = values.map(background => (Math.max(foreground, background) + .05)
        / (Math.min(foreground, background) + .05)).sort((a, b) => a - b);
      return ratios[Math.floor(ratios.length * .1)];
    };
    const candidates = [
      { ink: 'light' as Ink, rgb: inkColors.light }, { ink: 'dark' as Ink, rgb: inkColors.dark },
      { ink: 'balanced' as Ink, rgb: [gray, gray, gray] },
    ].map(candidate => ({ ...candidate, contrast: score(candidate.rgb) })).sort((a, b) => b.contrast - a.contrast);
    const previousCandidate = candidates.find(candidate => candidate.ink === button.dataset.ink);
    const previousRgb = button.style.getPropertyValue('--mt-glass-text').match(/\d+/gu)?.map(Number);
    const previous = previousCandidate && previousRgb?.length === 3
      ? { ...previousCandidate, rgb: previousRgb, contrast: score(previousRgb) } : previousCandidate;
    const best = previous && candidates[0].contrast - previous.contrast < .5 ? previous : candidates[0];
    setContrast(button, best.ink, best.rgb);
  } catch { fallback(button); }
}
