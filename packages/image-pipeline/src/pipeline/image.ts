import type { PlatformProvider, PipelineCanvas, PipelineImage } from "../runtime/platform";

export async function fileToImage(file: File, platform: PlatformProvider): Promise<PipelineImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });

  return platform.loadImage(dataUrl);
}

export function imageToCanvas(image: PipelineImage, platform: PlatformProvider): PipelineCanvas {
  const canvas = platform.createCanvas(image.naturalWidth, image.naturalHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("无法创建 Canvas 上下文");
  }
  ctx.drawImage(image, 0, 0);
  return canvas;
}

export function cloneCanvas(src: PipelineCanvas, platform: PlatformProvider): PipelineCanvas {
  const canvas = platform.createCanvas(src.width, src.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("无法克隆 Canvas");
  }
  ctx.drawImage(src, 0, 0);
  return canvas;
}