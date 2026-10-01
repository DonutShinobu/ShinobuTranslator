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
import { encodeCanvasToPngInWorker } from './pngWorkerEncoder';

const pendingFonts = new Map<string, Promise<void>>();

function registerFont(
  path: string,
  family: string,
  descriptors?: PipelineFontDescriptors,
): void {
  const key = `${path}\u0000${family}\u0000${descriptors?.style ?? ''}\u0000${descriptors?.weight ?? ''}`;
  if (pendingFonts.has(key)) return;

  const task = (async () => {
    // An optional benchmark observer separates font I/O from FontFace parsing.
    const observe = (globalThis as {
      __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
    }).__shinobuColdStartInitMark;
    const mark = (phase: string, startedAt: number, data?: Record<string, unknown>) => {
      if (!observe) return;
      try {
        observe({ phase, family, startedAt, durationMs: performance.now() - startedAt, ...data });
      } catch {
        // Diagnostic callbacks never affect font loading or output.
      }
    };
    const startedAt = observe ? performance.now() : 0;
    let stageStartedAt = startedAt;
    let status = 'failed';
    try {
      const response = await fetch(path);
      mark('font.fetch', stageStartedAt, { httpStatus: response.status });
      if (!response.ok) {
        throw new Error(`字体下载失败: ${response.status}`);
      }
      stageStartedAt = observe ? performance.now() : 0;
      const bytes = await response.arrayBuffer();
      mark('font.body', stageStartedAt, { bytes: bytes.byteLength });
      stageStartedAt = observe ? performance.now() : 0;
      let face: FontFace;
      if ((globalThis as { __shinobuColdStartFontBlobUrl?: boolean }).__shinobuColdStartFontBlobUrl === true
        && typeof URL.createObjectURL === 'function') {
        try {
          let fontUrl: string | undefined;
          try {
            // A Blob FontResource can use Chromium's background font decoder.
            // Keep exactly the fetched bytes and let FontFace retain the loaded data.
            fontUrl = URL.createObjectURL(new Blob([bytes], { type: 'font/woff2' }));
            const constructStartedAt = observe ? performance.now() : 0;
            face = new FontFace(family, `url("${fontUrl}")`, descriptors);
            mark('font.blob-url-construct', constructStartedAt);
            await face.load();
            mark('font.blob-url-loaded', stageStartedAt);
          } finally {
            if (fontUrl !== undefined) URL.revokeObjectURL(fontUrl);
          }
        } catch {
          // CSP/API/URL-load failures keep the original binary-font behavior.
          mark('font.blob-url-fallback', stageStartedAt);
          face = new FontFace(family, bytes, descriptors);
          await face.load();
        }
      } else {
        face = new FontFace(family, bytes, descriptors);
        await face.load();
      }
      mark('font.face-load', stageStartedAt);
      stageStartedAt = observe ? performance.now() : 0;
      document.fonts.add(face);
      mark('font.add', stageStartedAt);
      status = 'success';
    } finally {
      mark('font.register', startedAt, { status });
    }
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

  encodeCanvasToPng(canvas: PipelineCanvas): Blob | Promise<Blob> {
    if ((globalThis as { __shinobuColdStartWorkerPng?: boolean })
      .__shinobuColdStartWorkerPng === true && typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      return encodeCanvasToPngInWorker(canvas);
    }
    if ((globalThis as { __shinobuColdStartOffscreenPng?: boolean })
      .__shinobuColdStartOffscreenPng === true && typeof OffscreenCanvas !== 'undefined') {
      const surface = new OffscreenCanvas(canvas.width, canvas.height);
      const context = surface.getContext('2d');
      if (!context) throw new Error('导出译图失败');
      context.globalCompositeOperation = 'copy';
      context.drawImage(canvas as HTMLCanvasElement, 0, 0);
      return surface.convertToBlob({ type: 'image/png' }).finally(() => {
        surface.width = 0;
        surface.height = 0;
      });
    }
    // Chromium's async Blob export can wait 1s for an idle task in an
    // offscreen document. This host has no visible UI, so encode synchronously.
    return canvasToPngBlobSync(canvas);
  },

  registerFont,

  async waitForFonts(): Promise<void> {
    await Promise.all(pendingFonts.values());
  },
};
