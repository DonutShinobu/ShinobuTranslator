/**
 * Node.js PlatformProvider — uses node-canvas (npm package "canvas").
 *
 * All canvas/image operations are routed through the node-canvas library
 * which provides a Cairo-based implementation of the Canvas API.
 * Fonts are registered via node-canvas's registerFont; waitForFonts
 * resolves immediately since fonts are available right after registration.
 */

import { createCanvas, loadImage, registerFont, Image, ImageData } from 'canvas';
import type { PlatformProvider, PipelineCanvas, PipelineImage, PipelineImageData } from './platform';

export const nodePlatform: PlatformProvider = {
  createCanvas(width: number, height: number): PipelineCanvas {
    return createCanvas(width, height) as PipelineCanvas;
  },

  createImage(): PipelineImage {
    return new Image() as PipelineImage;
  },

  async loadImage(src: string): Promise<PipelineImage> {
    const img = await loadImage(src);
    return img as PipelineImage;
  },

  createImageData(width: number, height: number): PipelineImageData {
    return new ImageData(width, height) as PipelineImageData;
  },

  registerFont(path: string, family: string): void {
    // node-canvas registerFont takes a fontFace object {family, weight?, style?}
    // PlatformProvider only provides the family string, so we wrap it.
    registerFont(path, { family });
  },

  waitForFonts(): Promise<void> {
    // node-canvas fonts are available immediately after registerFont;
    // no async waiting needed unlike browser's document.fonts.ready.
    return Promise.resolve();
  },
};