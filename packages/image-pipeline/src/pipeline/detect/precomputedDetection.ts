import type { TextRegion } from '../../types';
import type { PlatformProvider, PipelineCanvas, PipelineImage } from '../../runtime/platform';
import type { DetectOutput } from './onnxDetect';
import { unpackDetectionMask } from './packedDetectionMask';

export type PrecomputedTextDetection = {
  width: number;
  height: number;
  packedMask: Blob;
  regions: readonly TextRegion[];
};

export function clonePrecomputedTextRegion(region: TextRegion): TextRegion {
  return {
    ...region,
    box: { ...region.box },
    quad: region.quad
      ? region.quad.map((point) => ({ ...point })) as TextRegion['quad']
      : undefined,
    sourceText: '',
    translatedText: '',
    bubbleMask: undefined,
  };
}

function binaryMaskToCanvas(
  binary: Uint8Array,
  width: number,
  height: number,
  platform: PlatformProvider,
): PipelineCanvas {
  const canvas = platform.createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法还原预检测 mask');
  const imageData = context.createImageData(width, height);
  for (let index = 0, pixel = 0; index < binary.length; index += 1, pixel += 4) {
    const value = binary[index] > 0 ? 255 : 0;
    imageData.data[pixel] = value;
    imageData.data[pixel + 1] = value;
    imageData.data[pixel + 2] = value;
    imageData.data[pixel + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

export async function materializePrecomputedDetection(
  detection: PrecomputedTextDetection,
  image: PipelineImage,
  platform: PlatformProvider,
): Promise<DetectOutput> {
  if (
    detection.width !== image.naturalWidth
    || detection.height !== image.naturalHeight
  ) {
    throw new Error('预检测结果与输入图片尺寸不一致');
  }
  const packed = new Uint8Array(await detection.packedMask.arrayBuffer());
  const binary = unpackDetectionMask(packed, detection.width, detection.height);
  return {
    regions: detection.regions.map(clonePrecomputedTextRegion),
    rawMaskCanvas: binaryMaskToCanvas(binary, detection.width, detection.height, platform),
    engine: 'onnx',
  };
}
