/**
 * Browser PlatformProvider — uses native DOM APIs.
 *
 * All methods are trivial wrappers around document.createElement, etc.
 * The DOM types (HTMLCanvasElement, HTMLImageElement) structurally
 * satisfy PipelineCanvas / PipelineImage, so we return them directly.
 */

import type {
  PipelineCanvas,
  PipelineFontDescriptors,
  PipelineImage,
  PipelineImageData,
  PipelinePlatform,
} from '@shinobu/image-pipeline';
import { canvasToPngBlobSync } from '@shinobu/image-pipeline/protocol';

const pendingFonts = new Map<string, Promise<void>>();

function registerFont(
  path: string,
  family: string,
  descriptors?: PipelineFontDescriptors,
): void {
  const key = `${path}\u0000${family}\u0000${descriptors?.style ?? ''}\u0000${descriptors?.weight ?? ''}`;
  if (pendingFonts.has(key)) return;

  const task = (async () => {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`字体下载失败: ${response.status}`);
    }
    const face = new FontFace(
      family,
      await response.arrayBuffer(),
      descriptors,
    );
    await face.load();
    document.fonts.add(face);
  })();
  pendingFonts.set(key, task);
}

export const browserPipelinePlatform: PipelinePlatform = {
  createCanvas(width: number, height: number): PipelineCanvas {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },

  createImage(): PipelineImage {
    return new Image();
  },

  loadImage(src: string): Promise<PipelineImage> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = src;
    });
  },

  createImageBitmap(image: PipelineImage): Promise<ImageBitmap> {
    return globalThis.createImageBitmap(image as HTMLImageElement);
  },

  createImageData(width: number, height: number): PipelineImageData {
    return new ImageData(width, height);
  },

  encodeCanvasToPng(canvas: PipelineCanvas): Blob {
    // Chromium's async Blob export can wait 1s for an idle task in an
    // offscreen document. This host has no visible UI, so encode synchronously.
    return canvasToPngBlobSync(canvas);
  },

  registerFont,

  async waitForFonts(): Promise<void> {
    await Promise.all(pendingFonts.values());
  },
};
