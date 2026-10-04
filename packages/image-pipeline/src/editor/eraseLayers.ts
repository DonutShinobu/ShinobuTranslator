import type { PipelineCanvas, PlatformProvider } from '../runtime/platform';
import type { EraseLayerCanvas, RegionMaskOwnership } from './types';

/** Partition the actual inpaint mask, including its upscaled edges. */
export function buildEraseLayerCanvases(
  cleaned: PipelineCanvas,
  mask: PipelineCanvas,
  ownership: RegionMaskOwnership,
  platform: PlatformProvider,
): EraseLayerCanvas[] {
  const { width, height } = cleaned;
  const maskPixels = mask.getContext('2d')!.getImageData(0, 0, width, height).data;
  const labels = new Int32Array(width * height);
  const bounds = ownership.regionIds.map(() => ({ x0: width, y0: height, x1: -1, y1: -1 }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (maskPixels[pixel * 4] <= 127) continue;
      const sx = Math.min(ownership.width - 1, Math.floor((x + 0.5) * ownership.width / width));
      const sy = Math.min(ownership.height - 1, Math.floor((y + 0.5) * ownership.height / height));
      let label = ownership.labels[sy * ownership.width + sx];
      // Interpolation can make the final mask foreground beside a labeled cell.
      for (let radius = 1; !label && radius <= 2; radius++) {
        for (let dy = -radius; !label && dy <= radius; dy++) {
          for (let dx = -radius; !label && dx <= radius; dx++) {
            const cx = sx + dx;
            const cy = sy + dy;
            if (cx >= 0 && cy >= 0 && cx < ownership.width && cy < ownership.height) {
              label = ownership.labels[cy * ownership.width + cx];
            }
          }
        }
      }
      if (!label || !bounds[label - 1]) throw new Error('去字图层缺少区域归属');
      labels[pixel] = label;
      const bound = bounds[label - 1];
      bound.x0 = Math.min(bound.x0, x); bound.y0 = Math.min(bound.y0, y);
      bound.x1 = Math.max(bound.x1, x); bound.y1 = Math.max(bound.y1, y);
    }
  }
  const layers: EraseLayerCanvas[] = [];
  try {
    for (let index = 0; index < bounds.length; index++) {
      const b = bounds[index];
      if (b.x1 < b.x0) continue;
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      const canvas = platform.createCanvas(w, h);
      layers.push({ regionId: ownership.regionIds[index], canvas, bounds: { x: b.x0, y: b.y0, width: w, height: h } });
      const context = canvas.getContext('2d')!;
      context.drawImage(cleaned, b.x0, b.y0, w, h, 0, 0, w, h);
      const pixels = context.getImageData(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (labels[(b.y0 + y) * width + b.x0 + x] !== index + 1) pixels.data[(y * w + x) * 4 + 3] = 0;
        }
      }
      context.putImageData(pixels, 0, 0);
    }
    return layers;
  } catch (error) {
    for (const layer of layers) {
      if (layer.canvas.dispose) layer.canvas.dispose();
      else { layer.canvas.width = 0; layer.canvas.height = 0; }
    }
    throw error;
  }
}
