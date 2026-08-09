import type { ModelRuntime } from '@shinobu/model-runtime';
import type { PlatformProvider } from '../../runtime/platform';
import { fileToImage } from '../image';
import { detectTextRegionsWithMask, type DetectionFallbackStrategy } from '.';
import { inspectPackedDetectionMaskEdges, packDetectionMask } from './packedDetectionMask';
import {
  clonePrecomputedTextRegion,
  type PrecomputedTextDetection,
} from './precomputedDetection';

export type TextDetectionProbeResult = {
  detection: PrecomputedTextDetection;
  detectorSignature: string;
  topTouches: boolean;
  bottomTouches: boolean;
  topStrength: number;
  bottomStrength: number;
};

export type TextDetectionProbeOptions = {
  platform: PlatformProvider;
  modelRuntime: ModelRuntime;
  detectionFallbackStrategy: DetectionFallbackStrategy;
  signal?: AbortSignal;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

export async function probeTextDetection(
  file: File,
  options: TextDetectionProbeOptions,
): Promise<TextDetectionProbeResult> {
  throwIfAborted(options.signal);
  const descriptor = await options.modelRuntime.readModel('detector');
  throwIfAborted(options.signal);
  const image = await fileToImage(file, options.platform);
  let maskCanvas: Awaited<ReturnType<typeof detectTextRegionsWithMask>>['rawMaskCanvas'] = null;
  try {
    throwIfAborted(options.signal);
    const detected = await detectTextRegionsWithMask(
      image,
      options.platform,
      options.modelRuntime,
      options.detectionFallbackStrategy,
    );
    throwIfAborted(options.signal);
    maskCanvas = detected.rawMaskCanvas;
    if (!maskCanvas) throw new Error('文本预检测没有返回原始 mask');
    if (maskCanvas.width !== image.naturalWidth || maskCanvas.height !== image.naturalHeight) {
      throw new Error('文本预检测 mask 尺寸与输入图片不一致');
    }
    const context = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取文本预检测 mask');
    const rgba = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    const binary = new Uint8Array(maskCanvas.width * maskCanvas.height);
    for (let index = 0, pixel = 0; index < binary.length; index += 1, pixel += 4) {
      binary[index] = rgba[pixel] > 127 ? 1 : 0;
    }
    const packed = packDetectionMask(binary, maskCanvas.width, maskCanvas.height);
    const packedBuffer = new Uint8Array(packed.length);
    packedBuffer.set(packed);
    const edges = inspectPackedDetectionMaskEdges(packed, maskCanvas.width, maskCanvas.height);
    return {
      detection: {
        width: maskCanvas.width,
        height: maskCanvas.height,
        packedMask: new Blob([packedBuffer.buffer], { type: 'application/octet-stream' }),
        regions: detected.regions.map(clonePrecomputedTextRegion),
      },
      detectorSignature: JSON.stringify({
        schema: 'onnx-text-mask-v1',
        name: descriptor.name,
        task: descriptor.task,
        url: descriptor.url,
        input: descriptor.input,
        runtime: descriptor.runtime,
        normalize: descriptor.normalize,
        channelOrder: descriptor.channelOrder,
        outputNormalize: descriptor.outputNormalize,
        maskFill: descriptor.maskFill,
        maskInputName: descriptor.maskInputName,
        actualProvider: detected.actualProvider,
        actualWebnnDeviceType: detected.actualWebnnDeviceType,
      }),
      ...edges,
    };
  } finally {
    if (maskCanvas) {
      if (maskCanvas.dispose) maskCanvas.dispose();
      else {
        maskCanvas.width = 0;
        maskCanvas.height = 0;
      }
    }
    image.close?.();
  }
}
