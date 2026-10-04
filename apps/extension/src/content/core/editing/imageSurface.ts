import type { EditableImage } from '@shinobu/image-pipeline/editor';

export type EditingSurface = {
  left: number; top: number; width: number; height: number;
  scaleX: number; scaleY: number; offsetX: number; offsetY: number;
};

function position(value: string, extra: number): number {
  if (value === 'left' || value === 'top') return 0;
  if (value === 'right' || value === 'bottom') return extra;
  if (value === 'center') return extra / 2;
  if (value.endsWith('%')) return extra * Number.parseFloat(value) / 100;
  return Number.parseFloat(value) || 0;
}

export function resolveEditingSurface(image: HTMLImageElement, size: Pick<EditableImage, 'width' | 'height'>): EditingSurface {
  const rect = image.getBoundingClientRect();
  const css = getComputedStyle(image);
  const ratioX = rect.width / (image.offsetWidth || rect.width || 1);
  const ratioY = rect.height / (image.offsetHeight || rect.height || 1);
  const edge = (name: string, ratio: number) => (Number.parseFloat(css.getPropertyValue(name)) || 0) * ratio;
  const leftInset = edge('border-left-width', ratioX) + edge('padding-left', ratioX);
  const topInset = edge('border-top-width', ratioY) + edge('padding-top', ratioY);
  const width = Math.max(0, rect.width - leftInset - edge('border-right-width', ratioX) - edge('padding-right', ratioX));
  const height = Math.max(0, rect.height - topInset - edge('border-bottom-width', ratioY) - edge('padding-bottom', ratioY));
  let scaleX = width / size.width, scaleY = height / size.height;
  const fit = css.objectFit;
  if (fit === 'contain' || fit === 'cover' || fit === 'scale-down' || fit === 'none') {
    const naturalScaleX = ratioX, naturalScaleY = ratioY;
    const contain = Math.min(scaleX / ratioX, scaleY / ratioY);
    const scale = fit === 'cover' ? Math.max(scaleX / ratioX, scaleY / ratioY)
      : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
    scaleX = naturalScaleX * scale; scaleY = naturalScaleY * scale;
  }
  const positions = (css.objectPosition || '50% 50%').split(/\s+/u);
  return {
    left: rect.left + leftInset, top: rect.top + topInset, width, height, scaleX, scaleY,
    offsetX: position(positions[0], width - size.width * scaleX),
    offsetY: position(positions[1] ?? '50%', height - size.height * scaleY),
  };
}

export function toEditingPoint(surface: EditingSurface, clientX: number, clientY: number) {
  return {
    x: (clientX - surface.left - surface.offsetX) / surface.scaleX,
    y: (clientY - surface.top - surface.offsetY) / surface.scaleY,
  };
}
