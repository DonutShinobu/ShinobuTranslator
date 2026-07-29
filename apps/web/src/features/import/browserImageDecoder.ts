import type { DecodedImage, ImageDecoder } from './imageImporter';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('浏览器未能生成缩略图'));
      }
    }, 'image/png');
  });
}

export const decodeBrowserImage: ImageDecoder = async (file): Promise<DecodedImage> => {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前浏览器不支持 ImageBitmap 解码');
  }

  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  let disposed = false;

  return {
    width: bitmap.width,
    height: bitmap.height,
    async createThumbnail(maxEdge: number): Promise<string> {
      if (disposed) throw new Error('图片解码资源已释放');

      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('当前浏览器不支持 Canvas 2D');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      try {
        const blob = await canvasToBlob(canvas);
        return URL.createObjectURL(blob);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bitmap.close();
    },
  };
};
