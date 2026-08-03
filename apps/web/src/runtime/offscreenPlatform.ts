import type {
  PipelineCanvas,
  PipelineImage,
  PipelineImageData,
  PipelineRenderingContext,
  PlatformProvider,
} from '@shinobu/image-pipeline/benchmark';

class BitmapPipelineImage implements PipelineImage {
  readonly src: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  onload: ((event: unknown) => unknown) | null = null;
  onerror: ((event: unknown) => unknown) | null = null;

  constructor(
    readonly bitmap: ImageBitmap,
    src: string,
  ) {
    this.src = src;
    this.naturalWidth = bitmap.width;
    this.naturalHeight = bitmap.height;
  }

  close(): void {
    this.bitmap.close();
  }
}

function unwrapImageSource(source: unknown): CanvasImageSource {
  if (source instanceof OffscreenPipelineCanvas) return source.surface;
  if (source instanceof BitmapPipelineImage) return source.bitmap;
  return source as CanvasImageSource;
}

function wrapContext(
  context: OffscreenCanvasRenderingContext2D,
): PipelineRenderingContext {
  return new Proxy(context, {
    get(target, property) {
      if (property === 'drawImage') {
        return (source: unknown, ...args: number[]): void => {
          const draw = target.drawImage as unknown as (
            image: CanvasImageSource,
            ...coordinates: number[]
          ) => void;
          draw.call(target, unwrapImageSource(source), ...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as unknown as PipelineRenderingContext;
}

class OffscreenPipelineCanvas implements PipelineCanvas {
  readonly surface: OffscreenCanvas;
  private context: PipelineRenderingContext | null = null;

  constructor(width: number, height: number) {
    this.surface = new OffscreenCanvas(width, height);
  }

  get width(): number {
    return this.surface.width;
  }

  set width(value: number) {
    this.surface.width = value;
  }

  get height(): number {
    return this.surface.height;
  }

  set height(value: number) {
    this.surface.height = value;
  }

  getContext(
    type: '2d',
    options?: CanvasRenderingContext2DSettings,
  ): PipelineRenderingContext | null {
    if (this.context) return this.context;
    const context = this.surface.getContext(type, options);
    this.context = context ? wrapContext(context) : null;
    return this.context;
  }

  toDataURL(): string {
    throw new Error('Worker Canvas 不支持同步 data URL 导出');
  }

  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    return this.surface.convertToBlob(options);
  }

  dispose(): void {
    this.context = null;
    this.surface.width = 0;
    this.surface.height = 0;
  }
}

type WorkerWithFonts = typeof globalThis & {
  fonts?: FontFaceSet;
};

export function createOffscreenPlatform(): PlatformProvider {
  const pendingFonts: Promise<void>[] = [];

  return {
    createCanvas(width, height) {
      return new OffscreenPipelineCanvas(width, height);
    },

    createImage(): PipelineImage {
      throw new Error('Worker 平台不支持可变 Image 元素');
    },

    async loadImage(src): Promise<PipelineImage> {
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`Worker 图片解码失败: ${response.status}`);
      }
      const bitmap = await createImageBitmap(await response.blob(), {
        imageOrientation: 'from-image',
      });
      return new BitmapPipelineImage(bitmap, src);
    },

    createImageBitmap(image): Promise<ImageBitmap> {
      if (!(image instanceof BitmapPipelineImage)) {
        throw new Error('Worker 收到了未知图片资源');
      }
      return globalThis.createImageBitmap(image.bitmap);
    },

    createImageData(width, height): PipelineImageData {
      return new ImageData(width, height);
    },

    registerFont(path, family, descriptors): void {
      const task = (async () => {
        const fontSet = (globalThis as WorkerWithFonts).fonts;
        if (!fontSet) {
          throw new Error('当前 Worker 不支持 FontFaceSet');
        }
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
        fontSet.add(face);
      })();
      pendingFonts.push(task);
    },

    async waitForFonts(): Promise<void> {
      await Promise.all(pendingFonts);
      // 每个注册任务已等待 FontFace.load() 并加入字体集。
      // Android Chromium 的 Worker FontFaceSet.ready 可能永远不结束。
    },
  };
}

export async function createNormalizedWorkingFile(
  source: File,
  dimensions: { width: number; height: number },
): Promise<File> {
  const bitmap = await createImageBitmap(source, {
    imageOrientation: 'from-image',
  });
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('当前 Worker 不支持 Canvas 2D');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new File([blob], `${source.name.replace(/\.[^.]+$/u, '') || 'source'}.png`, {
      type: 'image/png',
      lastModified: source.lastModified,
    });
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
