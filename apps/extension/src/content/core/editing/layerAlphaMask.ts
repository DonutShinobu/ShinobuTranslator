import type { EditableRasterLayer } from '@shinobu/image-pipeline/editor';

export type LayerAlphaMask = { width: number; height: number; alpha: Uint8Array };

/** Sprite rectangles only locate pixels. Transparent pixels do not capture a layer. */
export function hitsLayerAlpha(
  mask: LayerAlphaMask, layer: EditableRasterLayer, offsetX: number, offsetY: number,
  x: number, y: number, tolerance = 0,
): boolean {
  const [a, b, c, d, tx, ty] = layer.transform, determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-8) return false;
  const dx = x - tx - offsetX, dy = y - ty - offsetY;
  const localX = (d * dx - c * dy) / determinant, localY = (a * dy - b * dx) / determinant;
  const radius = Math.ceil(tolerance / Math.max(0.01, Math.min(Math.hypot(a, b), Math.hypot(c, d))));
  const left = Math.max(0, Math.floor(localX) - radius), right = Math.min(mask.width - 1, Math.floor(localX) + radius);
  const top = Math.max(0, Math.floor(localY) - radius), bottom = Math.min(mask.height - 1, Math.floor(localY) + radius);
  for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
    if (mask.alpha[py * mask.width + px] > 12) return true;
  }
  return false;
}
