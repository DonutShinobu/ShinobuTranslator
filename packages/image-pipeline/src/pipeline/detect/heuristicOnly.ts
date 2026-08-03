import type { TextRegion } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import { connectedComponents, makeRegion, mergeRects } from './onnxDetect';
import { clamp } from '../utils';

function estimateThreshold(grays: Uint8ClampedArray): number {
  let sum = 0;
  let sq = 0;
  for (let index = 0; index < grays.length; index += 1) {
    const value = grays[index];
    sum += value;
    sq += value * value;
  }
  const mean = sum / grays.length;
  const variance = Math.max(0, sq / grays.length - mean * mean);
  return clamp(Math.round(mean - Math.sqrt(variance) * 0.35), 70, 170);
}

export async function detectByHeuristic(
  image: PipelineImage,
  platform: PlatformProvider,
): Promise<TextRegion[]> {
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('文本检测阶段无法创建画布上下文');
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const totalPixels = width * height;
  const grays = new Uint8ClampedArray(totalPixels);
  for (let index = 0, pixel = 0; index < totalPixels; index += 1, pixel += 4) {
    grays[index] = Math.round(
      pixels[pixel] * 0.299 + pixels[pixel + 1] * 0.587 + pixels[pixel + 2] * 0.114,
    );
  }
  const threshold = estimateThreshold(grays);
  const dark = new Uint8Array(totalPixels);
  for (let index = 0; index < totalPixels; index += 1) {
    dark[index] = grays[index] < threshold ? 1 : 0;
  }

  const mapped = connectedComponents(dark, width, height);
  const scaleX = image.naturalWidth / width;
  const scaleY = image.naturalHeight / height;
  const pad = Math.max(4, Math.round(Math.min(scaleX, scaleY) * 6));
  const imageArea = image.naturalWidth * image.naturalHeight;
  const projected = mapped
    .map((rect) => {
      const x = clamp(Math.floor(rect.x * scaleX) - pad, 0, image.naturalWidth - 1);
      const y = clamp(Math.floor(rect.y * scaleY) - pad, 0, image.naturalHeight - 1);
      const right = clamp(Math.ceil((rect.x + rect.width) * scaleX) + pad, x + 1, image.naturalWidth);
      const bottom = clamp(Math.ceil((rect.y + rect.height) * scaleY) + pad, y + 1, image.naturalHeight);
      return { x, y, width: right - x, height: bottom - y };
    })
    .filter((rect) => {
      const ratio = (rect.width * rect.height) / imageArea;
      return ratio >= 0.00005 && ratio <= 0.18;
    });

  return mergeRects(projected, Math.max(6, Math.round(Math.min(scaleX, scaleY) * 12)))
    .sort((left, right) => right.width * right.height - left.width * left.height)
    .slice(0, 40)
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map(makeRegion);
}
