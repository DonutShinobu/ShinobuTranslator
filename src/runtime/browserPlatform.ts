/**
 * Browser PlatformProvider — uses native DOM APIs.
 *
 * All methods are trivial wrappers around document.createElement, etc.
 * The DOM types (HTMLCanvasElement, HTMLImageElement) structurally
 * satisfy PipelineCanvas / PipelineImage, so we return them directly.
 */

import type { PlatformProvider, PipelineCanvas, PipelineImage, PipelineImageData } from './platform';

export const browserPlatform: PlatformProvider = {
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

  createImageData(width: number, height: number): PipelineImageData {
    return new ImageData(width, height);
  },

  registerFont(_path: string, _family: string): void {
    // Browser loads fonts via CSS; no manual registration needed.
  },

  waitForFonts(): Promise<void> {
    return document.fonts.ready.then(() => {});
  },
};