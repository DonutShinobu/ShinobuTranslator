import type { TextRegion } from '../../types';

export type PaddleOcrInputData = {
  data: Float32Array;
  dims: number[];
  resizedWidth: number;
};

/**
 * 从 image 裁剪 region.box 区域，resize 到 inputHeight 高度，
 * 宽度按比例缩放（不超过 maxInputWidth），归一化后输出 NCHW Float32Array。
 */
export function buildPaddleOcrInput(
  image: HTMLImageElement,
  region: TextRegion,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one',
): PaddleOcrInputData {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const { x, y, width, height } = region.box;

  // Step 1: 从原图裁剪 region 区域
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, x, y, width, height, 0, 0, width, height);

  // Step 2: Resize 到 inputHeight，宽度按比例
  const ratio = inputHeight / height;
  const resizedWidth = Math.max(1, Math.min(maxInputWidth, Math.round(ratio * width)));

  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = resizedWidth;
  resizeCanvas.height = inputHeight;
  const resizeCtx = resizeCanvas.getContext('2d')!;
  resizeCtx.drawImage(canvas, 0, 0, resizedWidth, inputHeight);

  // Step 3: 提取像素并归一化
  const imageData = resizeCtx.getImageData(0, 0, resizedWidth, inputHeight);
  const pixels = imageData.data;
  const pixelCount = resizedWidth * inputHeight;

  const floatData = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    const r = pixels[srcIdx];
    const g = pixels[srcIdx + 1];
    const b = pixels[srcIdx + 2];

    if (normalize === 'minus_one_to_one') {
      floatData[i] = r / 127.5 - 1;
      floatData[pixelCount + i] = g / 127.5 - 1;
      floatData[2 * pixelCount + i] = b / 127.5 - 1;
    } else {
      floatData[i] = r / 255;
      floatData[pixelCount + i] = g / 255;
      floatData[2 * pixelCount + i] = b / 255;
    }
  }

  return {
    data: floatData,
    dims: [1, 3, inputHeight, resizedWidth],
    resizedWidth,
  };
}