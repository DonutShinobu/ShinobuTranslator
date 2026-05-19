import type { TextRegion } from '../../types';
import type { Direction } from './preprocess';
import { getTransformedRegion } from './preprocess';

export type PaddleOcrInputData = {
  data: Float32Array;
  dims: number[];
  resizedWidth: number;
};

/**
 * 从 image 裁剪 region 区域，对竖排文字做透视变换+90度旋转，
 * resize 到 inputHeight 高度，宽度按比例缩放（不超过 maxInputWidth），归一化后输出 NCHW Float32Array。
 */
export function buildPaddleOcrInput(
  image: HTMLImageElement,
  region: TextRegion,
  direction: Direction,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one',
): PaddleOcrInputData {
  // 使用 getTransformedRegion 处理透视变换和竖排旋转
  const source = getTransformedRegion(image, region, direction, inputHeight);
  const srcWidth = Math.max(1, source.width);
  const srcHeight = Math.max(1, source.height);

  // Resize 到 inputHeight，宽度按比例
  const ratio = srcWidth / srcHeight;
  const resizedWidth = Math.max(1, Math.min(maxInputWidth, Math.round(ratio * inputHeight)));

  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = resizedWidth;
  resizeCanvas.height = inputHeight;
  const resizeCtx = resizeCanvas.getContext('2d')!;
  resizeCtx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, resizedWidth, inputHeight);

  // 提取像素并归一化
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
